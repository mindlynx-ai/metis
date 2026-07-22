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
import {
  NODE_STATUS,
  type NodeExecPort,
  type NodeHandler,
  type NodeHandlerContext,
  type NodeExecutionResult,
} from '../node-exec-port.js';

/**
 * The open default NodeExecPort: an in-process handler registry. This
 * is also the plugin boundary: paid packs would call
 * registerNodeHandler on start; without a registration the type
 * resolves to the 501 unimplemented response, never a crash.
 */
export class NodeHandlerRegistry implements NodeExecPort {
  private readonly handlers = new Map<string, NodeHandler>();

  registerNodeHandler(type: string, handler: NodeHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`node handler for "${type}" is already registered`);
    }
    this.handlers.set(type, handler);
  }

  canExecute(type: string): boolean {
    return this.handlers.has(type);
  }

  async execute(ctx: NodeHandlerContext): Promise<NodeExecutionResult> {
    const handler = this.handlers.get(ctx.nodeRef.type);
    if (!handler) {
      return {
        status: NODE_STATUS.unimplemented,
        message:
          `node type "${ctx.nodeRef.type}" is not available in this edition; ` +
          'the workflow definition stays valid and the node can run after an upgrade',
      };
    }
    try {
      return await handler(ctx);
    } catch (error) {
      return {
        status: NODE_STATUS.failed,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
