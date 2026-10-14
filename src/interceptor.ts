import type { JitHarness } from "./harness.js";
import type { SkillIndex } from "./index-store.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export type ToolExecutionHandler = (name: string, args: Record<string, any>) => Promise<any>;

/**
 * McpProtocolInterceptor
 * Transparent JSON-RPC proxy sitting between the LLM client (Claude Code, Cursor, Windsurf)
 * and upstream tool executors / MCP servers.
 *
 * It transparently handles:
 * 1. `tools/list`: Intercepts and returns ONLY the lightweight meta-tools + active JIT skills.
 * 2. `tools/call`: Routes `search_skills` and `load_skill` to JitHarness, while forwarding
 *    actual tool calls to the upstream executor.
 */
export class McpProtocolInterceptor {
  private harness: JitHarness;
  private index: SkillIndex;
  private upstreamExecutor?: ToolExecutionHandler;

  constructor(harness: JitHarness, index: SkillIndex, upstreamExecutor?: ToolExecutionHandler) {
    this.harness = harness;
    this.index = index;
    this.upstreamExecutor = upstreamExecutor;
  }

  /**
   * Set or update upstream tool execution handler
   */
  public setUpstreamExecutor(executor: ToolExecutionHandler): void {
    this.upstreamExecutor = executor;
  }

  /**
   * Process an incoming MCP / JSON-RPC message
   */
  public async handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method, params } = message;

    try {
      // 1. Handshake / Initialize protocol pass-through
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: true },
            },
            serverInfo: {
              name: "SkillPrism Progressive JIT Gateway",
              version: "0.1.0",
            },
          },
        };
      }

      // 2. Intercept tools/list: Return only JIT meta-tools + actively loaded tools
      if (method === "tools/list") {
        const activeTools = this.harness.getActiveTools();
        const mcpFormattedTools = activeTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        }));

        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: mcpFormattedTools,
          },
        };
      }

      // 3. Intercept tools/call: Route meta-tools or execute target skill
      if (method === "tools/call") {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        if (!toolName) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Invalid params: 'name' is required for tools/call",
            },
          };
        }

        // Meta-tool 1: search_skills
        if (toolName === "search_skills") {
          const result = await this.harness.handleMetaToolCall("search_skills", toolArgs);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result.data, null, 2),
                },
              ],
            },
          };
        }

        // Meta-tool 2: load_skill
        if (toolName === "load_skill") {
          const result = await this.harness.handleMetaToolCall("load_skill", toolArgs);
          if (result.status === "error") {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: result.error || "Failed to load skill" }],
              },
            };
          }

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result.data, null, 2),
                },
              ],
            },
          };
        }

        // Target Activated Skill Execution
        const skill = this.index.get(toolName);
        if (!skill) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Tool '${toolName}' not found. Search for skills with 'search_skills' and activate with 'load_skill'.`,
            },
          };
        }

        if (this.upstreamExecutor) {
          const output = await this.upstreamExecutor(toolName, toolArgs);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: typeof output === "string" ? output : JSON.stringify(output, null, 2),
                },
              ],
            },
          };
        }

        // Fallback simulated execution for mock/local harness
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "executed",
                  skill: toolName,
                  inputs: toolArgs,
                  timestamp: new Date().toISOString(),
                }),
              },
            ],
          },
        };
      }

      // Default unrecognized method error
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method '${method}' not found`,
        },
      };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err.message || "Internal JSON-RPC interceptor error",
        },
      };
    }
  }
}
