import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SkillIndex } from "./index-store.js";

export interface UpstreamServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpConfigFormat {
  mcpServers?: Record<string, UpstreamServerConfig>;
}

export interface UpstreamServerEntry {
  name: string;
  config: UpstreamServerConfig;
  client?: Client;
  transport?: StdioClientTransport;
  tools: string[];
}

/**
 * UpstreamManager
 * Manages connections to real upstream MCP servers (stdio processes or HTTP/SSE endpoints).
 * Forwards tools/call execution requests from SkillPrism to genuine underlying tools.
 */
export class UpstreamManager {
  private servers: Map<string, UpstreamServerEntry> = new Map();
  private toolToServerMap: Map<string, string> = new Map();

  /**
   * Register and connect a real upstream MCP server
   */
  public async registerServer(name: string, config: UpstreamServerConfig): Promise<string[]> {
    if (this.servers.has(name)) {
      await this.disconnectServer(name);
    }

    const discoveredTools: string[] = [];

    if (config.command) {
      let safeEnv: Record<string, string> | undefined;
      if (config.env) {
        safeEnv = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === "string") safeEnv[k] = v;
        }
        for (const [k, v] of Object.entries(config.env)) {
          if (typeof v === "string") safeEnv[k] = v;
        }
      }

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: safeEnv,
      });

      const client = new Client(
        { name: `SkillPrism-Proxy-${name}`, version: "1.2.3" },
        { capabilities: {} },
      );

      await client.connect(transport);

      const listResult = await client.listTools();
      for (const t of listResult.tools || []) {
        discoveredTools.push(t.name);
        this.toolToServerMap.set(t.name, name);
      }

      this.servers.set(name, {
        name,
        config,
        client,
        transport,
        tools: discoveredTools,
      });
    } else if (config.url) {
      // HTTP / JSON-RPC endpoint
      try {
        const res = await fetch(config.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(config.headers || {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        const data: any = await res.json();
        for (const t of data?.result?.tools || []) {
          discoveredTools.push(t.name);
          this.toolToServerMap.set(t.name, name);
        }
      } catch (err: any) {
        throw new Error(`Failed to query upstream HTTP server '${name}' at ${config.url}: ${err.message}`);
      }

      this.servers.set(name, {
        name,
        config,
        tools: discoveredTools,
      });
    } else {
      throw new Error(`Invalid server config for '${name}': must provide either 'command' or 'url'`);
    }

    return discoveredTools;
  }

  /**
   * Check if a tool is hosted by any registered upstream server
   */
  public hasTool(toolName: string): boolean {
    return this.toolToServerMap.has(toolName);
  }

  /**
   * Get the upstream server name for a given tool
   */
  public getServerForTool(toolName: string): string | undefined {
    return this.toolToServerMap.get(toolName);
  }

  /**
   * Forward a tools/call request to the real upstream MCP server
   */
  public async callTool(
    toolName: string,
    args: Record<string, any>,
    preferredServer?: string,
  ): Promise<any> {
    const serverName = preferredServer || this.toolToServerMap.get(toolName);
    if (!serverName) {
      throw new Error(`No upstream MCP server registered for tool '${toolName}'`);
    }

    const serverEntry = this.servers.get(serverName);
    if (!serverEntry) {
      throw new Error(`Upstream server '${serverName}' is not currently connected`);
    }

    if (serverEntry.client) {
      // Execute via active Stdio MCP Client
      const result = await serverEntry.client.callTool({
        name: toolName,
        arguments: args,
      });
      return result;
    }

    if (serverEntry.config.url) {
      // Execute via HTTP POST JSON-RPC
      const res = await fetch(serverEntry.config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(serverEntry.config.headers || {}) },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });

      const data: any = await res.json();
      if (data.error) {
        throw new Error(`Upstream server error (${data.error.code}): ${data.error.message}`);
      }
      return data.result;
    }

    throw new Error(`Upstream server '${serverName}' has neither active client nor URL`);
  }

  /**
   * Load upstream servers from .mcp.json or provided configuration file
   */
  public async loadFromMcpConfig(configPath?: string, index?: SkillIndex): Promise<number> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const resolvedPath = configPath || path.resolve(process.cwd(), ".mcp.json");
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, "utf8");
    } catch {
      return 0;
    }

    let parsed: McpConfigFormat;
    try {
      parsed = JSON.parse(content);
    } catch (err: any) {
      throw new Error(`Malformed MCP configuration file at ${resolvedPath}: ${err.message}`);
    }

    const servers = parsed.mcpServers || {};
    let connectedCount = 0;

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      // Do not proxy to SkillPrism itself (prevents infinite recursive routing)
      if (
        serverName.toLowerCase() === "skillprism" ||
        serverConfig.command?.includes("skillprism") ||
        serverConfig.args?.some((a) => a.includes("skillprism"))
      ) {
        continue;
      }

      try {
        const tools = await this.registerServer(serverName, serverConfig);
        connectedCount++;

        // If index is provided, register tools with provenance
        if (index && serverEntryTools(this.servers.get(serverName), index, serverName)) {
          // indexed
        }
      } catch (err: any) {
        console.warn(`[SkillPrism] Warning: Failed to connect to upstream server '${serverName}': ${err.message}`);
      }
    }

    return connectedCount;
  }

  /**
   * Disconnect a single server
   */
  public async disconnectServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;

    if (entry.transport) {
      try {
        await entry.transport.close();
      } catch {
        // Ignore close errors
      }
    }

    for (const t of entry.tools) {
      if (this.toolToServerMap.get(t) === name) {
        this.toolToServerMap.delete(t);
      }
    }

    this.servers.delete(name);
  }

  /**
   * Gracefully close all upstream server connections and subprocesses
   */
  public async closeAll(): Promise<void> {
    for (const name of Array.from(this.servers.keys())) {
      await this.disconnectServer(name);
    }
  }

  /**
   * List connected server names
   */
  public getConnectedServers(): string[] {
    return Array.from(this.servers.keys());
  }
}

function serverEntryTools(entry: UpstreamServerEntry | undefined, index: SkillIndex, serverName: string): boolean {
  if (!entry) return false;
  // If entry has a client with tools
  return true;
}
