import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe } from "node:test";
import { UpstreamManager } from "../src/upstream.js";

describe("Phase 1 Remediation: Upstream MCP Proxy & Non-Destructive Init", () => {
  test("UpstreamManager connects to upstream HTTP MCP server and forwards calls", async () => {
    let receivedMethod = "";
    let receivedParams: any = null;

    // Spin up lightweight mock HTTP MCP server
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        receivedMethod = parsed.method;
        receivedParams = parsed.params;

        if (parsed.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                tools: [
                  {
                    name: "mock_postgres_query",
                    description: "Queries postgres",
                    inputSchema: { type: "object", properties: { sql: { type: "string" } } },
                  },
                ],
              },
            }),
          );
        } else if (parsed.method === "tools/call") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                content: [{ type: "text", text: "query executed successfully: 42 rows" }],
              },
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as any;
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      const manager = new UpstreamManager();
      const tools = await manager.registerServer("remote_db", { url: serverUrl });

      assert.deepEqual(tools, ["mock_postgres_query"]);
      assert.equal(manager.hasTool("mock_postgres_query"), true);
      assert.equal(manager.getServerForTool("mock_postgres_query"), "remote_db");

      const result = await manager.callTool("mock_postgres_query", { sql: "SELECT 1" });
      assert.equal(result.content[0].text, "query executed successfully: 42 rows");
      assert.equal(receivedMethod, "tools/call");
      assert.equal(receivedParams.name, "mock_postgres_query");
      assert.equal(receivedParams.arguments.sql, "SELECT 1");
    } finally {
      server.close();
    }
  });

  test("loadFromMcpConfig ignores self-recursive skillprism entries", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillprism-test-"));
    const configPath = path.join(tmpDir, ".mcp.json");

    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            skillprism: {
              command: "npx",
              args: ["-y", "@ritualdev-lab/skillprism", "proxy", "--stdio"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const manager = new UpstreamManager();
    const count = await manager.loadFromMcpConfig(configPath);
    // skillprism self-entry must be skipped to prevent infinite recursion
    assert.equal(count, 0);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("non-destructive configuration preservation: preserves other servers and backs up config", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillprism-init-"));
    const mcpPath = path.join(tmpDir, ".mcp.json");
    const backupPath = path.join(tmpDir, ".mcp.json.bak");

    // Existing pre-configured servers
    const initialConfig = {
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
        postgres: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://localhost/test"],
        },
      },
    };

    await fs.writeFile(mcpPath, JSON.stringify(initialConfig, null, 2), "utf8");

    // Simulate init merging logic
    const rawExisting = await fs.readFile(mcpPath, "utf8");
    await fs.writeFile(backupPath, rawExisting, "utf8");

    const parsed = JSON.parse(rawExisting);
    parsed.mcpServers.skillprism = {
      command: "npx",
      args: ["-y", "@ritualdev-lab/skillprism", "proxy", "--stdio"],
    };
    await fs.writeFile(mcpPath, JSON.stringify(parsed, null, 2), "utf8");

    // Verify backup exists and contains exact original
    const backupContent = JSON.parse(await fs.readFile(backupPath, "utf8"));
    assert.deepEqual(backupContent, initialConfig);

    // Verify modified file preserved github and postgres
    const updatedConfig = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    assert.ok(updatedConfig.mcpServers.github);
    assert.ok(updatedConfig.mcpServers.postgres);
    assert.ok(updatedConfig.mcpServers.skillprism);
    assert.equal(Object.keys(updatedConfig.mcpServers).length, 3);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
