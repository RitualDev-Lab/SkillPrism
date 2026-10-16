import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import * as readline from "node:readline";
import { JitHarness } from "./harness.js";
import {
  type JsonRpcNotification,
  McpProtocolInterceptor,
} from "./interceptor.js";

export interface ProxyServerOptions {
  port?: number;
  host?: string;
  authToken?: string;
  allowedOrigins?: string[];
  maxBodySizeBytes?: number;
  enableSessionIsolation?: boolean;
}

interface SseClient {
  res: ServerResponse;
  sessionId?: string;
}

interface SessionRecord {
  interceptor: McpProtocolInterceptor;
  lastActiveMs: number;
}

/**
 * SkillPrismProxyServer
 * Provides real stdio and HTTP/SSE JSON-RPC transport layers for SkillPrism
 * to act as a transparent MCP server for Claude Code, Cursor, Windsurf, and Antigravity.
 * Includes HTTP Bearer Authentication, CORS Origin controls, Request Size Limiting,
 * Session Isolation, and real-time `notifications/tools/list_changed` dispatch.
 */
export class SkillPrismProxyServer {
  private interceptor: McpProtocolInterceptor;
  private httpServer?: ReturnType<typeof createServer>;
  private sseClients: Set<SseClient> = new Set();
  private unsubscribeNotifications?: () => void;
  private activeRl?: readline.Interface;
  private sweepTimer?: NodeJS.Timeout;

  // Multi-tenant / Session Isolation registry
  private sessions: Map<string, SessionRecord> = new Map();
  private sessionIsolationEnabled = false;
  private authToken?: string;
  private allowedOrigins?: string[];
  private maxBodySizeBytes = 2 * 1024 * 1024; // 2MB default limit

  constructor(interceptor: McpProtocolInterceptor) {
    this.interceptor = interceptor;

    // Listen to global outgoing MCP notifications (e.g. notifications/tools/list_changed)
    this.unsubscribeNotifications = this.interceptor.onNotification(
      (notification: JsonRpcNotification) => {
        this.broadcastSseNotification(notification);
      },
    );
  }

  /**
   * Broadcast an outgoing notification to connected SSE clients.
   * If targetSessionId is specified, sends to clients tied to that session or global listeners.
   */
  private broadcastSseNotification(
    notification: JsonRpcNotification,
    targetSessionId?: string,
  ): void {
    const payload = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;
    for (const client of this.sseClients) {
      if (
        !targetSessionId ||
        !client.sessionId ||
        client.sessionId === targetSessionId
      ) {
        try {
          client.res.write(payload);
        } catch {
          this.sseClients.delete(client);
        }
      }
    }
  }

  /**
   * Look up or lazily instantiate an isolated interceptor/harness for a given session ID
   */
  public getOrCreateSessionInterceptor(sessionId: string): McpProtocolInterceptor {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActiveMs = Date.now();
      return existing.interceptor;
    }

    const masterHarness = this.interceptor.getHarness();
    const sessionHarness = new JitHarness(
      masterHarness.getIndex(),
      masterHarness.getDefaultTtlTurns(),
      masterHarness.getDefaultIdleTtlMs(),
    );

    const sessionInterceptor = new McpProtocolInterceptor(
      sessionHarness,
      masterHarness.getIndex(),
      this.interceptor.getUpstreamExecutor(),
      this.interceptor.getCompactor(),
      ["*"],
      this.interceptor.isSimulationMode(),
    );

    const upstreamMgr = this.interceptor.getUpstreamManager();
    if (upstreamMgr) {
      sessionInterceptor.setUpstreamManager(upstreamMgr);
    }
    sessionInterceptor.setAutoStepTurns(this.interceptor.isAutoStepTurns());

    // Forward session notifications
    sessionInterceptor.onNotification((notification) => {
      this.broadcastSseNotification(notification, sessionId);
    });

    this.sessions.set(sessionId, {
      interceptor: sessionInterceptor,
      lastActiveMs: Date.now(),
    });

    return sessionInterceptor;
  }

  public getSessionCount(): number {
    return this.sessions.size;
  }

  public getSessionInterceptor(sessionId: string): McpProtocolInterceptor | undefined {
    return this.sessions.get(sessionId)?.interceptor;
  }

  /**
   * Start stdio JSON-RPC loop (Standard transport for Claude Desktop / Claude Code)
   */
  public startStdio(
    inputStream: NodeJS.ReadableStream = process.stdin,
    outputStream: NodeJS.WritableStream = process.stdout,
  ): void {
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
   * Start HTTP JSON-RPC & Server-Sent Events (SSE) server with auth, CORS, and size limits
   */
  public startHttp(options: ProxyServerOptions = {}): Promise<void> {
    const port = options.port !== undefined ? options.port : 8080;
    const host = options.host || "127.0.0.1";

    this.authToken = options.authToken || process.env.SKILLPRISM_AUTH_TOKEN;
    this.allowedOrigins = options.allowedOrigins;
    this.maxBodySizeBytes = options.maxBodySizeBytes || 2 * 1024 * 1024;
    this.sessionIsolationEnabled = Boolean(options.enableSessionIsolation);

    return new Promise((resolve, reject) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const origin = req.headers.origin;

        // 1. Origin / CORS Controls
        if (this.allowedOrigins && this.allowedOrigins.length > 0 && !this.allowedOrigins.includes("*")) {
          if (origin && !this.allowedOrigins.includes(origin)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Forbidden",
                message: `Origin '${origin}' is not authorized.`,
              }),
            );
            return;
          }
          if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
          }
        } else {
          res.setHeader("Access-Control-Allow-Origin", origin || "*");
        }

        res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, mcp-session-id, x-session-id",
        );
        res.setHeader("Access-Control-Allow-Credentials", "true");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const urlObj = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
        const pathname = urlObj.pathname;

        // 2. Health check endpoint (can be queried unauthenticated)
        if (req.method === "GET" && (pathname === "/health" || pathname === "/")) {
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
              activeSessions: this.sessions.size,
              security: {
                authConfigured: Boolean(this.authToken),
                sessionIsolation: this.sessionIsolationEnabled,
                maxBodySizeBytes: this.maxBodySizeBytes,
              },
            }),
          );
          return;
        }

        // 3. HTTP Authentication Check
        if (this.authToken) {
          const authHeader = req.headers.authorization;
          let providedToken: string | undefined;

          if (authHeader) {
            if (authHeader.startsWith("Bearer ")) {
              providedToken = authHeader.slice(7).trim();
            } else {
              providedToken = authHeader.trim();
            }
          } else {
            providedToken = urlObj.searchParams.get("token") || undefined;
          }

          if (providedToken !== this.authToken) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Unauthorized",
                message: "Missing or invalid authorization token.",
              }),
            );
            return;
          }
        }

        // 4. Session Identification & Routing
        const sessionId = (req.headers["mcp-session-id"] ||
          req.headers["x-session-id"] ||
          urlObj.searchParams.get("sessionId") ||
          "") as string;

        const activeInterceptor =
          sessionId && (this.sessionIsolationEnabled || req.headers["mcp-session-id"] || req.headers["x-session-id"])
            ? this.getOrCreateSessionInterceptor(sessionId)
            : this.interceptor;

        // 5. Server-Sent Events (SSE) stream endpoint
        if (req.method === "GET" && (pathname === "/sse" || pathname === "/events")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const addr = server.address();
          const actualPort = addr && typeof addr === "object" ? addr.port : port;
          res.write(`event: endpoint\ndata: http://${host}:${actualPort}/mcp\n\n`);

          const clientRecord: SseClient = { res, sessionId: sessionId || undefined };
          this.sseClients.add(clientRecord);

          req.on("close", () => {
            this.sseClients.delete(clientRecord);
          });
          return;
        }

        // 6. JSON-RPC endpoint
        if (
          req.method === "POST" &&
          (pathname === "/mcp" || pathname === "/rpc" || pathname === "/")
        ) {
          // Pre-check Content-Length header against max payload size limit
          const contentLengthStr = req.headers["content-length"];
          if (contentLengthStr) {
            const contentLength = Number.parseInt(contentLengthStr, 10);
            if (contentLength > this.maxBodySizeBytes) {
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "Payload Too Large",
                  message: `Request size ${contentLength} bytes exceeds limit of ${this.maxBodySizeBytes} bytes.`,
                }),
              );
              return;
            }
          }

          let body = "";
          let bodyBytes = 0;
          let rejected = false;

          req.on("data", (chunk: Buffer) => {
            if (rejected) return;
            bodyBytes += chunk.length;
            if (bodyBytes > this.maxBodySizeBytes) {
              rejected = true;
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "Payload Too Large",
                  message: `Streaming request body exceeded size limit of ${this.maxBodySizeBytes} bytes.`,
                }),
              );
              req.destroy();
              return;
            }
            body += chunk.toString("utf8");
          });

          req.on("end", async () => {
            if (rejected) return;
            try {
              const parsed = JSON.parse(body);
              const result = await activeInterceptor.handleMessage(parsed);
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

  public getAddress(): { port: number; host: string } | null {
    if (!this.httpServer) return null;
    const addr = this.httpServer.address();
    if (!addr || typeof addr === "string") return null;
    return { port: addr.port, host: addr.address };
  }

  public getConnectedSseClientCount(): number {
    return this.sseClients.size;
  }

  /**
   * Start periodic idle sweep to prune expired skills across main harness and active sessions
   */
  public startIdleSweep(intervalMs = 1000): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    this.sweepTimer = setInterval(() => {
      // 1. Prune main harness
      this.interceptor.getHarness().pruneExpiredSkills();

      // 2. Prune sessions and idle session harnesses
      const now = Date.now();
      const sessionTtlMs = 1000 * 60 * 15; // 15 minutes session inactivity
      for (const [id, session] of this.sessions.entries()) {
        session.interceptor.getHarness().pruneExpiredSkills();
        if (now - session.lastActiveMs > sessionTtlMs) {
          this.sessions.delete(id);
        }
      }
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  public stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  public async close(): Promise<void> {
    this.stopIdleSweep();

    if (this.activeRl) {
      this.activeRl.close();
      this.activeRl = undefined;
    }

    for (const client of this.sseClients) {
      try {
        client.res.end();
      } catch {
        // Closed
      }
    }
    this.sseClients.clear();
    this.sessions.clear();

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
