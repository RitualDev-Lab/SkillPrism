import { ContextCompactor } from "./compactor.js";
import type { JitHarness } from "./harness.js";
import type { SkillIndex } from "./index-store.js";
import type { UpstreamManager } from "./upstream.js";

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

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

export type NotificationListener = (notification: JsonRpcNotification) => void;

export type ToolExecutionHandler = (name: string, args: Record<string, any>) => Promise<any>;

/**
 * Normalizes any parameter definition or schema into a strict, standard
 * Model Context Protocol (MCP) JSON Schema object.
 */
export function toMcpInputSchema(parameters: any): {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  [key: string]: any;
} {
  if (!parameters) {
    return {
      type: "object",
      properties: {},
    };
  }

  // If already an object schema
  if (typeof parameters === "object" && !Array.isArray(parameters)) {
    const { type: _type, properties = {}, required, ...rest } = parameters;
    return {
      type: "object",
      properties: typeof properties === "object" && !Array.isArray(properties) ? properties : {},
      ...(Array.isArray(required) && required.length > 0 ? { required } : {}),
      ...rest,
    };
  }

  // If parameters is an array of parameter descriptors (e.g. SkillParameter[])
  if (Array.isArray(parameters)) {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const p of parameters) {
      if (!p || typeof p !== "object") continue;
      const paramName = p.name || p.id;
      if (!paramName) continue;

      properties[paramName] = {
        type: p.type || "string",
        ...(p.description ? { description: p.description } : {}),
        ...(p.default !== undefined ? { default: p.default } : {}),
        ...(Array.isArray(p.enum) ? { enum: p.enum } : {}),
        ...(p.items ? { items: p.items } : {}),
        ...(p.properties ? { properties: p.properties } : {}),
      };
      if (p.required) {
        required.push(paramName);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  return {
    type: "object",
    properties: {},
  };
}

/**
 * McpProtocolInterceptor
 * Transparent JSON-RPC proxy sitting between the LLM client (Claude Code, Cursor, Windsurf)
 * and upstream tool executors / real MCP servers.
 */
export class McpProtocolInterceptor {
  private harness: JitHarness;
  private index: SkillIndex;
  private compactor: ContextCompactor;
  private upstreamExecutor?: ToolExecutionHandler;
  private upstreamManager?: UpstreamManager;
  private simulationMode = false;

  private clientPermissions: Set<string> = new Set(["*"]);
  private notificationListeners: NotificationListener[] = [];
  private unsubscribeHarness?: () => void;
  private autoStepTurns = true;

  constructor(
    harness: JitHarness,
    index: SkillIndex,
    upstreamExecutor?: ToolExecutionHandler,
    compactor?: ContextCompactor,
    initialPermissions: string[] = ["*"],
    simulationMode = false,
  ) {
    this.harness = harness;
    this.index = index;
    this.upstreamExecutor = upstreamExecutor;
    this.compactor = compactor || new ContextCompactor();
    this.clientPermissions = new Set(initialPermissions);
    this.simulationMode = simulationMode;

    // Automatically emit notifications/tools/list_changed whenever harness activates or prunes tools
    this.unsubscribeHarness = this.harness.onToolsChanged(() => {
      this.notifyToolsListChanged();
    });
  }

  /**
   * Subscribe to outgoing MCP JSON-RPC notifications (e.g. notifications/tools/list_changed)
   */
  public onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.push(listener);
    return () => {
      this.notificationListeners = this.notificationListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Dispatches an outgoing MCP notification to all registered transport streams
   */
  public emitNotification(method: string, params: any = {}): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        // Guard against listener failure
      }
    }
  }

  /**
   * Dispatches notifications/tools/list_changed according to Model Context Protocol specification
   */
  public notifyToolsListChanged(): void {
    this.emitNotification("notifications/tools/list_changed", {});
  }

  public setGrantedPermissions(permissions: string[]): void {
    this.clientPermissions = new Set(permissions);
  }

  public getCompactor(): ContextCompactor {
    return this.compactor;
  }

  public getHarness(): JitHarness {
    return this.harness;
  }

  public setAutoStepTurns(enabled: boolean): void {
    this.autoStepTurns = enabled;
  }

  public isAutoStepTurns(): boolean {
    return this.autoStepTurns;
  }

  /**
   * Set or update upstream tool execution handler
   */
  public setUpstreamExecutor(executor: ToolExecutionHandler): void {
    this.upstreamExecutor = executor;
  }

  public getUpstreamExecutor(): ToolExecutionHandler | undefined {
    return this.upstreamExecutor;
  }

  /**
   * Set or update upstream MCP server manager
   */
  public setUpstreamManager(manager: UpstreamManager): void {
    this.upstreamManager = manager;
  }

  public getUpstreamManager(): UpstreamManager | undefined {
    return this.upstreamManager;
  }

  /**
   * Set whether mock simulation mode is allowed when no upstream executor is connected
   */
  public setSimulationMode(enabled: boolean): void {
    this.simulationMode = enabled;
  }

  public isSimulationMode(): boolean {
    return this.simulationMode;
  }

  private formatToolResult(id: string | number, toolName: string, rawOutput: any): JsonRpcResponse {
    // If output is already in standard MCP result format ({ content: [...], isError?: boolean })
    if (
      rawOutput &&
      typeof rawOutput === "object" &&
      (Array.isArray(rawOutput.content) || rawOutput.isError !== undefined)
    ) {
      const content = Array.isArray(rawOutput.content)
        ? rawOutput.content
        : rawOutput.isError
          ? [{ type: "text", text: "Upstream tool reported an error" }]
          : [];

      const { result } = this.compactor.compactMcpResult(toolName, {
        ...rawOutput,
        content,
      });

      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    }

    const { output } = this.compactor.compact(toolName, rawOutput);
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

  /**
   * Process an incoming MCP / JSON-RPC message
   */
  public async handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method, params } = message;

    try {
      // 0. Handle MCP ping
      if (method === "ping") {
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {},
        };
      }

      // Handle notifications (no response required or empty result)
      if (
        method.startsWith("notifications/") ||
        method === "initialized" ||
        method === "$/cancelRequest"
      ) {
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {},
        };
      }

      // 1. Handshake / Initialize protocol pass-through
      if (method === "initialize") {
        const clientProto = params?.protocolVersion || "2024-11-05";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: clientProto,
            capabilities: {
              tools: { listChanged: true },
            },
            serverInfo: {
              name: "SkillPrism Progressive JIT Gateway",
              version: "1.2.3",
            },
          },
        };
      }

      // 2. Intercept tools/list: Return only JIT meta-tools + actively loaded tools with valid JSON Schema
      if (method === "tools/list") {
        const activeTools = this.harness.getActiveTools();
        const mcpFormattedTools = activeTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: toMcpInputSchema((t as any).inputSchema || t.parameters),
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

        // Meta-tool 3: inspect_receipt
        if (toolName === "inspect_receipt") {
          const ref = toolArgs.ref;
          const path = toolArgs.path;
          const inspected = this.compactor.inspectReceipt(ref, path);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(inspected, null, 2),
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
              message: `Tool '${toolName}' not found in registry. Use 'search_skills' to discover available tools.`,
            },
          };
        }

        // Enforce Progressive Disclosure: Skill MUST be actively loaded via load_skill
        if (!this.harness.isSkillActive(toolName)) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32002,
              message: `JIT Gate Block: Tool '${toolName}' is indexed out-of-context but has not been activated. Call 'load_skill({ skill_id: "${toolName}" })' first before calling this tool.`,
            },
          };
        }

        // Enforce Server-Side Configured Permissions (Not self-granted from client params)
        if (skill.permissions && skill.permissions.length > 0) {
          const hasWildcard = this.clientPermissions.has("*");
          const missing = skill.permissions.filter(
            (p) => !hasWildcard && !this.clientPermissions.has(p),
          );
          if (missing.length > 0) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32003,
                message: `Permission Denied: Execution of '${toolName}' requires server-granted permissions [${missing.join(", ")}].`,
              },
            };
          }
        }

        // Touch active skill sliding window if calling an active tool
        this.harness.touchSkill(toolName);

        // 1. Direct Upstream Executor
        if (this.upstreamExecutor) {
          try {
            const rawOutput = await this.upstreamExecutor(toolName, toolArgs);
            const response = this.formatToolResult(id, toolName, rawOutput);
            if (this.autoStepTurns) this.harness.stepTurn();
            return response;
          } catch (execErr: any) {
            if (this.autoStepTurns) this.harness.stepTurn();
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Upstream tool execution error: ${execErr.message || String(execErr)}`,
                  },
                ],
              },
            };
          }
        }

        // 2. Upstream MCP Server via UpstreamManager
        if (this.upstreamManager?.hasTool(toolName)) {
          try {
            const upstreamResult = await this.upstreamManager.callTool(
              toolName,
              toolArgs,
              skill.sourceServer,
            );
            const response = this.formatToolResult(id, toolName, upstreamResult);
            if (this.autoStepTurns) this.harness.stepTurn();
            return response;
          } catch (upstreamErr: any) {
            if (this.autoStepTurns) this.harness.stepTurn();
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Upstream MCP server error: ${upstreamErr.message || String(upstreamErr)}`,
                  },
                ],
              },
            };
          }
        }

        // 3. Fallback: Simulation mode explicitly opted in via --dry-run-simulation
        if (this.simulationMode) {
          if (this.autoStepTurns) this.harness.stepTurn();
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "simulated",
                      dryRun: true,
                      skill: toolName,
                      inputs: toolArgs,
                      timestamp: new Date().toISOString(),
                      notice:
                        "Simulated execution (--dry-run-simulation is enabled). No upstream server was invoked.",
                    },
                    null,
                    2,
                  ),
                },
              ],
            },
          };
        }

        // 4. Default Fail-Closed: Never fake execution silently!
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: `Tool execution failed: No upstream executor or MCP server connected for tool '${toolName}'. Pass --dry-run-simulation if you intend to mock tool execution.`,
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
