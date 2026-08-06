/*
 * Copyright 2026 Seillen Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  ConnectionRecord,
  ConnectorCredentialStore,
  CreateConnectionInput,
  SecretRequest,
} from '../credential-port.js';

/** A stored connection: its metadata plus the (encrypted-at-rest) material. */
interface StoredConnection {
  name: string;
  connectorId: string;
  connectionType?: string;
  baseUrl?: string;
  authScheme?: string;
  material: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface Vault {
  secrets: Record<string, string>;
  /** Keyed `${tenantId}/${connectionId}`. */
  connections: Record<string, StoredConnection>;
}

/** Project a stored connection's metadata (never its material). */
function projectConnection(stored: StoredConnection): Omit<ConnectionRecord, 'connectionId'> {
  return {
    name: stored.name,
    connectorId: stored.connectorId,
    connectionType: stored.connectionType,
    baseUrl: stored.baseUrl,
    authScheme: stored.authScheme,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

const ALGORITHM = 'aes-256-gcm';

/**
 * Publish the vault by writing beside it and renaming over it.
 *
 * Every save re-encrypts the WHOLE vault, and `writeFileSync` truncates the
 * target before it writes: a kill, a container OOM, a full disk or a power loss
 * inside that window left `credentials.enc` half-written, which is not one lost
 * edit but every credential for every connector gone at once, surfacing as an
 * opaque throw from resolveConnectorCredentials on the next dispatch. There is
 * no backup and no partial recovery. The window is not rare either: account
 * token rotation rewrites the whole vault roughly hourly.
 *
 * A rename over an existing path is atomic, so a reader sees the old file or the
 * new one and never a partial one. Two details it depends on:
 *
 *   - the temp file lives in the SAME directory, because rename is only atomic
 *     within one filesystem, and /tmp is frequently a different one;
 *   - the mode is set when the temp file is CREATED, not afterwards, so the
 *     ciphertext is never briefly readable by anyone else.
 *
 * The fsync is before the rename, and it is the file's, not the directory's.
 * Before, because the rename is what publishes the bytes and a power loss must
 * not publish a file whose contents never reached the disk. Not the directory's,
 * because losing the rename loses this one save and leaves the previous vault
 * intact and readable, which is the safe side of that trade; losing the contents
 * is the failure this exists to prevent.
 */
function writeVaultAtomically(filePath: string, contents: string): void {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = openSync(tempPath, 'w', 0o600);
    try {
      writeFileSync(handle, contents);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    // A half-written temp file is litter beside the secrets; it never becomes
    // the vault, but it should not sit there either.
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/** How long a lock may be held before a waiter assumes its owner died. */
const LOCK_STALE_MS = 5_000;
/** How long a waiter tries before it gives up and fails the mutation. */
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 5;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The open default CredentialPort: a local AES-256-GCM encrypted file,
 * bring-your-own-key. Plaintext exists only in the return values of the
 * resolve methods; the vault contents are non-enumerable so casual
 * serialisation of the adapter never leaks material.
 */
export class LocalFileCredentialStore implements ConnectorCredentialStore {
  constructor(
    private readonly filePath: string,
    key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('credential key must be 32 bytes');
    Object.defineProperty(this, 'key', { value: key, enumerable: false, writable: false });
  }

  private get keyBuffer(): Buffer {
    return (this as unknown as { key: Buffer }).key;
  }

  private load(): Vault {
    if (!existsSync(this.filePath)) return { secrets: {}, connections: {} };
    const envelope = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
      iv: string;
      tag: string;
      data: string;
    };
    const decipher = createDecipheriv(ALGORITHM, this.keyBuffer, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as Vault;
  }

  private save(vault: Vault): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.keyBuffer, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(vault), 'utf8'), cipher.final()]);
    const envelope = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeVaultAtomically(this.filePath, JSON.stringify(envelope));
  }

  /** Is the lock old enough that its owner is presumed dead? */
  private static lockIsStale(lockPath: string): boolean {
    try {
      return statSync(lockPath).mtimeMs < Date.now() - LOCK_STALE_MS;
    } catch {
      return false; // it went away on its own; the next create will win it
    }
  }

  /**
   * Run one read-modify-write with nobody else inside it.
   *
   * The atomic rename in `writeVaultAtomically` stops a reader seeing half a
   * file. It does nothing about a LOST UPDATE, which is the other failure and
   * the more likely one: every mutator loads the whole vault, edits it and
   * writes the whole vault back, so a server refreshing a rotating OAuth token
   * while an operator adds a connection from the CLI ends with whichever
   * renamed second, and the other entry is simply gone. It surfaces much later
   * as "connection has no credentials", with nothing anywhere saying a write
   * was dropped. Two real processes on this code lost 45 of 92 writes.
   *
   * `openSync(path, 'wx')` is an atomic create-if-absent, so exactly one
   * waiter wins it, and it works between processes, which an in-process mutex
   * would not: the two writers here are usually the server and the CLI.
   *
   * ponytail: covers writers that share a filesystem, which is what `.metis`
   * is. It does NOT cover two hosts pointed at one vault over NFS or SMB,
   * where O_EXCL is not reliably atomic; that wants a lock service, and the
   * BYOK-file adapter is the wrong place for one.
   *
   * A process killed mid-mutation leaves the lock behind, so a lock older than
   * LOCK_STALE_MS is taken over rather than waited on forever - the vault
   * itself is fine, the rename either happened or did not. Release removes the
   * lock only while it is still the same file we created, so a takeover we
   * lost is not then deleted out from under its new owner.
   */
  private async withVaultLock<T>(mutate: () => T): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const giveUp = Date.now() + LOCK_TIMEOUT_MS;
    let held: number | undefined;
    while (held === undefined) {
      try {
        closeSync(openSync(lockPath, 'wx', 0o600));
        held = statSync(lockPath).ino;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (LocalFileCredentialStore.lockIsStale(lockPath)) rmSync(lockPath, { force: true });
        else if (Date.now() >= giveUp)
          throw new Error('credential vault is locked by another writer');
        else await delay(LOCK_POLL_MS);
      }
    }
    try {
      return mutate();
    } finally {
      // Ours only. A lock taken from us as stale is a DIFFERENT file at the
      // same path, and removing it would drop a writer that is mid-mutation
      // back into exactly the race this exists to stop.
      try {
        if (statSync(lockPath).ino === held) rmSync(lockPath, { force: true });
      } catch {
        // Already gone: nothing to release.
      }
    }
  }

  async setSecret(tenantId: string, secretId: string, value: string): Promise<void> {
    await this.withVaultLock(() => {
      const vault = this.load();
      vault.secrets[`${tenantId}/${secretId}`] = value;
      this.save(vault);
    });
  }

  async createConnection(tenantId: string, input: CreateConnectionInput): Promise<ConnectionRecord> {
    return this.withVaultLock(() => {
      const vault = this.load();
      const connectionId = `conn_${randomUUID()}`;
      const now = new Date().toISOString();
      const stored: StoredConnection = {
        name: input.name,
        connectorId: input.connectorId,
        connectionType: input.connectionType,
        baseUrl: input.baseUrl,
        authScheme: input.authScheme,
        material: input.material,
        createdAt: now,
        updatedAt: now,
      };
      vault.connections[`${tenantId}/${connectionId}`] = stored;
      this.save(vault);
      return { connectionId, ...projectConnection(stored) };
    });
  }

  async updateConnection(
    tenantId: string,
    connectionId: string,
    changes: { name?: string; material?: Record<string, string> },
  ): Promise<void> {
    await this.withVaultLock(() => {
      const vault = this.load();
      const existing = vault.connections[`${tenantId}/${connectionId}`];
      if (!existing) throw new Error(`connection ${connectionId} not found`);
      if (changes.name !== undefined) existing.name = changes.name;
      // Merge, never replace: editing one field (a rotated secret) must not drop
      // the others (a connector carries several - Stripe has three).
      if (changes.material !== undefined) {
        existing.material = { ...existing.material, ...changes.material };
      }
      existing.updatedAt = new Date().toISOString();
      this.save(vault);
    });
  }

  async deleteConnection(tenantId: string, connectionId: string): Promise<void> {
    await this.withVaultLock(() => {
      const vault = this.load();
      delete vault.connections[`${tenantId}/${connectionId}`];
      this.save(vault);
    });
  }

  async listConnections(tenantId: string): Promise<ConnectionRecord[]> {
    const vault = this.load();
    const prefix = `${tenantId}/`;
    return Object.entries(vault.connections)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ connectionId: key.slice(prefix.length), ...projectConnection(value) }));
  }

  async resolveSecret(request: SecretRequest): Promise<string> {
    const vault = this.load();
    const value = vault.secrets[`${request.tenantId}/${request.secretId}`];
    if (value === undefined) {
      throw new Error(`secret ${request.secretId} is not defined`);
    }
    return value;
  }

  async resolveConnectorCredentials(
    tenantId: string,
    connectionId: string,
  ): Promise<Record<string, string>> {
    const vault = this.load();
    const connection = vault.connections[`${tenantId}/${connectionId}`];
    if (!connection) {
      throw new Error(`connection ${connectionId} has no credentials`);
    }
    return { ...connection.material };
  }

  toString(): string {
    return `LocalFileCredentialStore(${this.filePath})`;
  }
}
