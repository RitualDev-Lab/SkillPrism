import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import * as readline from "node:readline";
import type { JsonRpcNotification, McpProtocolInterceptor } from "./interceptor.js";

export interface ProxyServerOptions {
  port?: number;
  host?: string;
}

/**
 * SkillPrismProxyServer
 * Provides real stdio and HTTP/SSE JSON-RPC transport layers for SkillPrism
 * to act as a transparent MCP server for Claude Code, Cursor, Windsurf, and Antigravity.
 * Dispatches real-time `notifications/tools/list_changed` events across all active transports.
 */
export class SkillPrismProxyServer {
  private interceptor: McpProtocolInterceptor;
  private httpServer?: ReturnType<typeof createServer>;
  private sseClients: Set<ServerResponse> = new Set();
  private unsubscribeNotifications?: () => void;
  private activeRl?: readline.Interface;

  constructor(interceptor: McpProtocolInterceptor) {
    this.interceptor = interceptor;

    // Listen to outgoing MCP notifications (e.g. notifications/tools/list_changed)
    this.unsubscribeNotifications = this.interceptor.onNotification(
      (notification: JsonRpcNotification) => {
        this.broadcastSseNotification(notification);
      },
    );
  }

  /**
   * Broadcast an outgoing notification to all connected SSE clients
   */
  private broadcastSseNotification(notification: JsonRpcNotification): void {
    const payload = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  /**
   * Start stdio JSON-RPC loop (Standard transport for Claude Desktop / Claude Code)
   * Supports custom input/output streams for automated end-to-end integration testing.
   */
  public startStdio(
    inputStream: NodeJS.ReadableStream = process.stdin,
    outputStream: NodeJS.WritableStream = process.stdout,
  ): void {
    // Forward all interceptor notifications to stdio output
    this.interceptor.onNotification((notification: JsonRpcNotification) => {
      try {
        outputStream.write(`${JSON.stringify(notification)}\n`);
      } catch {
        // Output stream closed
      }
    });

    const rl = readline.createInterface({
      input: inputStream,
      output: outputStream,
      terminal: false,
    });
    this.activeRl = rl;

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const parsed = JSON.parse(trimmed);
        const response = await this.interceptor.handleMessage(parsed);
        // Only reply if message is not a notification (has an id)
        if (parsed.id !== undefined && parsed.id !== null) {
          outputStream.write(`${JSON.stringify(response)}\n`);
        }
      } catch (err: any) {
        outputStream.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: "Parse error",
              data: err.message,
            },
          })}\n`,
        );
      }
    });

    if (inputStream === process.stdin) {
      process.stderr.write("[SkillPrism] Stdio MCP Proxy listening on stdin/stdout\n");
    }
  }

  /**
   * Start HTTP JSON-RPC & Server-Sent Events (SSE) server
   */
  public startHttp(options: ProxyServerOptions = {}): Promise<void> {
    const port = options.port !== undefined ? options.port : 8080;
    const host = options.host || "127.0.0.1";

    return new Promise((resolve, reject) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Health check endpoint
        if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              service: "SkillPrism Progressive JIT Gateway",
              version: "1.2.3",
              protocol: "MCP 2024-11-05",
              capabilities: {
                tools: { listChanged: true },
              },
            }),
          );
          return;
        }

        // Server-Sent Events (SSE) stream endpoint
        if (req.method === "GET" && (req.url === "/sse" || req.url === "/events")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          const addr = server.address();
          const actualPort = addr && typeof addr === "object" ? addr.port : port;
          res.write(`event: endpoint\ndata: http://${host}:${actualPort}/mcp\n\n`);
          this.sseClients.add(res);

          req.on("close", () => {
            this.sseClients.delete(res);
          });
          return;
        }

        // JSON-RPC endpoint
        if (
          req.method === "POST" &&
          (req.url === "/mcp" || req.url === "/rpc" || req.url === "/")
        ) {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });

          req.on("end", async () => {
            try {
              const parsed = JSON.parse(body);
              const result = await this.interceptor.handleMessage(parsed);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32700, message: `Parse error: ${err.message}` },
                }),
              );
            }
          });
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });

      this.httpServer = server;

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = addr && typeof addr === "object" ? addr.port : port;
        console.log(`[SkillPrism] Transparent MCP Proxy running at http://${host}:${actualPort}/mcp`);
        resolve();
      });
    });
  }

  /**
   * Returns active HTTP server socket address (port, host)
   */
  public getAddress(): { port: number; host: string } | null {
    if (!this.httpServer) return null;
    const addr = this.httpServer.address();
    if (!addr || typeof addr === "string") return null;
    return { port: addr.port, host: addr.address };
  }

  /**
   * Returns count of currently active SSE stream subscriptions
   */
  public getConnectedSseClientCount(): number {
    return this.sseClients.size;
  }

  private sweepTimer?: NodeJS.Timeout;

  /**
   * Start periodic idle sweep to prune wall-clock expired tools and notify clients
   */
  public startIdleSweep(intervalMs = 1000): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    this.sweepTimer = setInterval(() => {
      this.interceptor.getHarness().pruneExpiredSkills();
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Stop the periodic idle sweep
   */
  public stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Gracefully close active server transports
   */
  public async close(): Promise<void> {
    this.stopIdleSweep();

    if (this.activeRl) {
      this.activeRl.close();
      this.activeRl = undefined;
    }

    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // Closed
      }
    }
    this.sseClients.clear();

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = undefined;
    }

    if (this.unsubscribeNotifications) {
      this.unsubscribeNotifications();
      this.unsubscribeNotifications = undefined;
    }
  }
}
