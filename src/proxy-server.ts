import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import * as readline from "node:readline";
import type { McpProtocolInterceptor } from "./interceptor.js";

export interface ProxyServerOptions {
  port?: number;
  host?: string;
}

/**
 * SkillPrismProxyServer
 * Provides real stdio and HTTP/SSE JSON-RPC transport layers for SkillPrism
 * to act as a transparent MCP server for Claude Code, Cursor, Windsurf, and Antigravity.
 */
export class SkillPrismProxyServer {
  private interceptor: McpProtocolInterceptor;

  constructor(interceptor: McpProtocolInterceptor) {
    this.interceptor = interceptor;
  }

  /**
   * Start stdio JSON-RPC loop (Standard transport for Claude Desktop / Claude Code)
   */
  public startStdio(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const parsed = JSON.parse(trimmed);
        const response = await this.interceptor.handleMessage(parsed);
        // Only reply if message is not a notification (has an id)
        if (parsed.id !== undefined && parsed.id !== null) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      } catch (err: any) {
        process.stdout.write(
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

    process.stderr.write("[SkillPrism] Stdio MCP Proxy listening on stdin/stdout\n");
  }

  /**
   * Start HTTP JSON-RPC & Server-Sent Events (SSE) server
   */
  public startHttp(options: ProxyServerOptions = {}): Promise<void> {
    const port = options.port || 8080;
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
              version: "1.1.1",
              protocol: "MCP 2024-11-05",
            }),
          );
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

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(port, host, () => {
        console.log(`[SkillPrism] Transparent MCP Proxy running at http://${host}:${port}/mcp`);
        resolve();
      });
    });
  }
}
