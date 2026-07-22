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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
    writeFileSync(this.filePath, JSON.stringify(envelope), { mode: 0o600 });
  }

  async setSecret(tenantId: string, secretId: string, value: string): Promise<void> {
    const vault = this.load();
    vault.secrets[`${tenantId}/${secretId}`] = value;
    this.save(vault);
  }

  async createConnection(tenantId: string, input: CreateConnectionInput): Promise<ConnectionRecord> {
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
  }

  async updateConnection(
    tenantId: string,
    connectionId: string,
    changes: { name?: string; material?: Record<string, string> },
  ): Promise<void> {
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
  }

  async deleteConnection(tenantId: string, connectionId: string): Promise<void> {
    const vault = this.load();
    delete vault.connections[`${tenantId}/${connectionId}`];
    this.save(vault);
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
