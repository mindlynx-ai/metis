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

/**
 * The capability resolver: a NodeExecPort in front of the handler registry
 * that binds each dispatch to its backend. The resolution order is the
 * spec's, and its one inviolable rule is NO SILENT CLOUD: without an
 * entitlement, the workflow's consent and an explicit choice, everything
 * runs locally. When cloud is chosen but unreachable (or the plan lapsed),
 * a 'both' node degrades to its local backend and says so via `binding`.
 *
 * Its second rule is NO OTHER DATA SOURCE: the cloud reads its own warehouse,
 * so a step that names any other connection is refused rather than bound, and
 * the user is told which connection and what to do about it.
 */
import { asDatasetRef } from '../data-source-port.js';
import {
  isCompleted,
  stateEnvelope,
  type NodeExecPort,
  type NodeExecutionResult,
  type NodeHandlerContext,
  type NodeRef,
} from '../node-exec-port.js';
import {
  ContractMismatchError,
  GatewayUnreachableError,
  UnentitledError,
  type CapabilityGatewayClient,
  type CapabilityRouting,
} from '../uplift.js';

/** The catalogue facts the resolver needs about a node type. */
export interface CapabilityEntry {
  execution?: string;
  entitlement?: string;
}

export interface CapabilityResolverOptions {
  /** The local backend (the NodeHandlerRegistry). */
  local: NodeExecPort;
  /** Catalogue lookup for a node type's execution location + entitlement. */
  entryFor(type: string): CapabilityEntry | undefined;
  /** The account's capability set (short-TTL cached, empty when not connected). */
  entitlements(): Promise<ReadonlySet<string>>;
  /** Absent = the kill switch: nothing ever routes to the cloud. */
  gateway?: CapabilityGatewayClient;
  /** 'inline' polls the job to terminal inside this call (short jobs, no
   *  Temporal needed); 'park' returns an accepted-job park signal the engine
   *  awaits durably (the worker's mode). Default 'inline'. */
  mode?: 'inline' | 'park';
  /** Poll cadence for the inline job wait. */
  pollIntervalMs?: number;
  /** Ceiling for the inline job wait (must stay inside the activity budget). */
  maxPollMs?: number;
}

/**
 * The one engine the cloud data plane runs. The gateway is handed a query and
 * runs it on the account's own cloud warehouse; the invoke payload carries no
 * connection, so the cloud can only ever read this engine.
 */
export const CLOUD_DATA_ENGINE = 'athena';

/**
 * The refusal a cloud-bound step earns by naming a connection the cloud cannot
 * reach, else undefined.
 *
 * The bind used to be decided from the capability and consent alone, so a step
 * aimed at the user's own database and switched to "In the cloud" had its SQL
 * run against the cloud warehouse instead: different rows, no error, no log.
 * Refusing is deliberately chosen over carrying the engine through the invoke
 * payload so the gateway could dispatch per engine - it is a fraction of the
 * size and it cannot mis-execute, and the gateway has exactly one engine today.
 *
 * Only a POSITIVELY foreign connection is refused. Untouched: a step naming no
 * connection (the cloud supplies the warehouse), one that names the cloud
 * engine, and one whose engine is not recorded at all. Silence means "authored
 * before the picker started recording the engine", not "foreign": refusing it
 * would break workflows that already exist, and breaking a saved definition to
 * close a latent path is not a trade this guard gets to make.
 *
 * The residual is deliberate and it is named here: a legacy step that is never
 * reopened keeps the old silent behaviour until it is saved again, which the
 * picker fixes the moment its connection is touched.
 */
function foreignConnectionRefusal(nodeRef: NodeRef): NodeExecutionResult | undefined {
  const config = nodeRef.config ?? {};
  const ref = asDatasetRef(config.sourceRef);
  const connectionId = String(ref?.connectionId ?? config.connectorId ?? config.connectionId ?? '');
  if (connectionId === '') return undefined;
  const engine = String(ref?.engine ?? config.engine ?? '');
  if (engine === '' || engine === CLOUD_DATA_ENGINE) return undefined;
  return {
    status: 400,
    message:
      `this step is set to run in the cloud, but it reads the connection "${connectionId}", ` +
      'which the cloud cannot reach: a step running in the cloud queries the cloud data ' +
      'warehouse instead, so it would hand on the wrong rows without ever failing. ' +
      'Point the step at the cloud data source, or set "Where it runs" back to on this computer.',
    nodeData: { code: 'cloud-connection' },
  };
}

/** The park signal a 'park'-mode cloud dispatch returns via nodeAction. */
export const CLOUD_PARK_ACTION = { type: 'cloud', action: 'park' } as const;

/** The accepted jobId when a result is a cloud park, else undefined. */
export function cloudParkJobId(result: NodeExecutionResult): string | undefined {
  if (result.nodeAction?.type !== CLOUD_PARK_ACTION.type) return undefined;
  if (result.nodeAction.action !== CLOUD_PARK_ACTION.action) return undefined;
  return (result.nodeAction.data as { jobId?: string } | undefined)?.jobId;
}

export class CapabilityResolver implements NodeExecPort {
  constructor(private readonly options: CapabilityResolverOptions) {}

  canExecute(type: string): boolean {
    if (this.options.local.canExecute(type)) return true;
    const entry = this.options.entryFor(type);
    return entry?.execution === 'cloud' || entry?.execution === 'both';
  }

  async execute(ctx: NodeHandlerContext): Promise<NodeExecutionResult> {
    const entry = this.options.entryFor(ctx.nodeRef.type);
    if (!(await this.bindsCloud(entry, ctx.routing, ctx.nodeRef.config))) {
      return this.options.local.execute(ctx);
    }
    // Cloud is chosen: the step's own connection has to be one the cloud can
    // read, or nothing runs at all. Never a quiet fall back to local either -
    // the run would then read the right rows while the choice was ignored.
    const refusal = foreignConnectionRefusal(ctx.nodeRef);
    if (refusal) return refusal;
    try {
      return await this.runCloud(entry as Required<CapabilityEntry>, ctx);
    } catch (error) {
      // Only pre-acceptance failures land here (unreachable, unentitled,
      // contract mismatch): the job never started, so the local backend can
      // safely take the dispatch. A degraded bind is visible, never silent.
      if (entry?.execution === 'both') {
        const local = await this.options.local.execute(ctx);
        return { ...local, binding: 'local-degraded', message: `${degradeReason(error)}; ${local.message}` };
      }
      return { status: 500, message: degradeReason(error), binding: 'cloud' };
    }
  }

  /** The spec's resolution order; false = bind local, silently and correctly. */
  private async bindsCloud(
    entry: CapabilityEntry | undefined,
    routing: CapabilityRouting | undefined,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.options.gateway) return false;
    if (!entry?.entitlement) return false;
    if (entry.execution === 'cloud') return true; // cloud-only: try, fail closed
    if (entry.execution !== 'both') return false;
    if (!routing?.enabled || !routing.consentAt) return false; // no silent cloud
    if (!(await this.options.entitlements()).has(entry.entitlement)) return false;
    if (routing.nodeMode === 'cloud') return true;
    if (routing.nodeMode === 'auto' && routing.thresholdBytes) {
      // ponytail: payload size = the substituted config's JSON bytes; real
      // input-payload sizing arrives with the reference pattern (manifests).
      return JSON.stringify(config ?? {}).length > routing.thresholdBytes;
    }
    return false;
  }

  private async runCloud(
    entry: Required<CapabilityEntry>,
    ctx: NodeHandlerContext,
  ): Promise<NodeExecutionResult> {
    const gateway = this.options.gateway as CapabilityGatewayClient;
    const capability = entry.entitlement.replace(/^cap\./, '');
    const accepted = await gateway.invoke(capability, {
      nodeType: ctx.nodeRef.type,
      config: ctx.nodeRef.config,
      executionId: ctx.executionId,
    });
    if (this.options.mode === 'park') {
      // The engine parks the node and awaits the job durably (pollCloudJob).
      return {
        status: 202,
        message: 'accepted by the cloud',
        nodeAction: { ...CLOUD_PARK_ACTION, data: { jobId: accepted.jobId } },
        binding: 'cloud',
      };
    }
    // ponytail: inline bounded poll - the stub completes in milliseconds and
    // this stays inside the activity budget; the parked-node path (durable
    // wait + heartbeated poll in the workflow) replaces it for long jobs.
    const interval = this.options.pollIntervalMs ?? 200;
    const deadline = Date.now() + (this.options.maxPollMs ?? 60_000);
    for (;;) {
      const job = await gateway.job(accepted.jobId);
      if (job.status === 'done') {
        const output = job.result ?? job.manifest ?? {};
        return {
          status: 200,
          message: 'completed in the cloud',
          nodeData: stateEnvelope(ctx.nodeRef.id, ctx.nodeRef.type, output),
          binding: 'cloud',
        };
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        return { status: 500, message: job.error ?? `cloud job ${job.status}`, binding: 'cloud' };
      }
      if (Date.now() >= deadline) {
        // The job was accepted and may still finish; failing beats silently
        // re-running the work locally on top of it.
        return { status: 500, message: 'the cloud job did not finish in time', binding: 'cloud' };
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

function degradeReason(error: unknown): string {
  if (error instanceof UnentitledError) return error.offer ? `not in your plan (${error.offer.title})` : error.message;
  if (error instanceof ContractMismatchError) return error.message;
  if (error instanceof GatewayUnreachableError) return 'the cloud was not reachable';
  return error instanceof Error ? error.message : 'cloud dispatch failed';
}

/** True when a completed result actually ran in the cloud (test helper). */
export function ranInCloud(result: NodeExecutionResult): boolean {
  return isCompleted(result.status) && result.binding === 'cloud';
}
