import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { describe } from "node:test";
import { JitHarness } from "../src/harness.js";
import { SkillIndex } from "../src/index-store.js";
import { type JsonRpcNotification, McpProtocolInterceptor } from "../src/interceptor.js";
import { SkillPrismProxyServer } from "../src/proxy-server.js";

describe("Phase 3 (S3): Real-Time Dynamic Tool Change Notifications (tools/list_changed) Suite", () => {
  function setupTestHarness() {
    const index = new SkillIndex();
    index.register({
      id: "aws_s3_upload",
      name: "AWS S3 File Upload",
      summary: "Uploads binary files and objects directly to S3 buckets",
      description: "Streams local files to Amazon S3.",
      category: "cloud",
      tags: ["aws", "s3"],
      parameters: [
        { name: "bucket", type: "string", description: "Target S3 bucket", required: true },
        { name: "key", type: "string", description: "Destination key", required: true },
      ],
    });
    index.register({
      id: "postgres_query",
      name: "PostgreSQL Query Exec",
      summary: "Executes parameterized read queries",
      description: "Performs read-only SQL queries.",
      category: "database",
      tags: ["sql", "postgres"],
      parameters: [{ name: "sql", type: "string", description: "SQL statement", required: true }],
    });

    const harness = new JitHarness(index, 2);
    const interceptor = new McpProtocolInterceptor(harness, index, async () => ({ status: "ok" }));
    return { index, harness, interceptor };
  }

  test("McpProtocolInterceptor advertises capabilities.tools.listChanged: true on initialize", async () => {
    const { interceptor } = setupTestHarness();

    const initRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    assert.equal(initRes.id, 1);
    assert.ok(initRes.result?.capabilities?.tools?.listChanged);
    assert.equal(initRes.result.capabilities.tools.listChanged, true);
  });

  test("S3 Regression: load_skill triggers notifications/tools/list_changed emission", async () => {
    const { interceptor } = setupTestHarness();

    const notifications: JsonRpcNotification[] = [];
    interceptor.onNotification((notif) => {
      notifications.push(notif);
    });

    // Initial state: 0 notifications
    assert.equal(notifications.length, 0);

    // Call load_skill to dynamically activate aws_s3_upload
    const loadRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "load_skill",
        arguments: { skill_id: "aws_s3_upload" },
      },
    });

    assert.equal(loadRes.id, 2);
    assert.ok(!loadRes.error);

    // Verify notifications/tools/list_changed was emitted
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].jsonrpc, "2.0");
    assert.equal(notifications[0].method, "notifications/tools/list_changed");
    assert.deepEqual(notifications[0].params, {});
  });

  test("S3 Regression: tool expiration and manual unloading triggers notifications/tools/list_changed", async () => {
    const { interceptor, harness } = setupTestHarness();

    const notifications: JsonRpcNotification[] = [];
    interceptor.onNotification((notif) => {
      notifications.push(notif);
    });

    // 1. Activate skill (emits notification 1)
    await harness.handleMetaToolCall("load_skill", { skill_id: "postgres_query" });
    assert.equal(notifications.length, 1);

    // 2. Unload skill manually (emits notification 2)
    const unloaded = harness.unloadSkill("postgres_query");
    assert.equal(unloaded, true);
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].method, "notifications/tools/list_changed");

    // 3. Reactivate and step turn until TTL expires
    await harness.handleMetaToolCall("load_skill", { skill_id: "postgres_query" });
    assert.equal(notifications.length, 3);

    // Advance turns: TTL is 2 turns
    harness.stepTurn(); // turn 2
    assert.equal(notifications.length, 3); // not yet expired
    harness.stepTurn(); // turn 3 -> expired! (emits notification 4)
    assert.equal(notifications.length, 4);
    assert.equal(notifications[3].method, "notifications/tools/list_changed");
  });

  test("SkillPrismProxyServer delivers notifications/tools/list_changed over stdio stream", async () => {
    const { interceptor } = setupTestHarness();
    const proxy = new SkillPrismProxyServer(interceptor);

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    proxy.startStdio(inputStream, outputStream);

    const receivedChunks: string[] = [];
    outputStream.on("data", (chunk) => {
      receivedChunks.push(chunk.toString("utf8"));
    });

    // Send load_skill request over stdio input
    const req = {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "load_skill",
        arguments: { skill_id: "aws_s3_upload" },
      },
    };
    inputStream.write(`${JSON.stringify(req)}\n`);

    // Allow async tick for event loop
    await new Promise((resolve) => setTimeout(resolve, 50));

    const combinedOutput = receivedChunks.join("");
    const lines = combinedOutput
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Must contain both the notification and the call response
    const notificationLine = lines.find((l) => l.includes("notifications/tools/list_changed"));
    assert.ok(notificationLine, "Stdio stream must receive notifications/tools/list_changed");

    const parsedNotif = JSON.parse(notificationLine);
    assert.equal(parsedNotif.jsonrpc, "2.0");
    assert.equal(parsedNotif.method, "notifications/tools/list_changed");

    await proxy.close();
  });

  test("SkillPrismProxyServer delivers real-time notifications/tools/list_changed to SSE subscribers", async () => {
    const { interceptor } = setupTestHarness();
    const proxy = new SkillPrismProxyServer(interceptor);

    // Start on random ephemeral port
    await proxy.startHttp({ port: 0 });
    const addr = proxy.getAddress();
    assert.ok(addr);

    // Connect SSE client
    const controller = new AbortController();
    const sseResponse = await fetch(`http://127.0.0.1:${addr.port}/sse`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });

    assert.equal(sseResponse.status, 200);
    assert.equal(proxy.getConnectedSseClientCount(), 1);

    const reader = sseResponse.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();

    // Read initial endpoint event
    const initialChunk = await reader.read();
    const initialText = decoder.decode(initialChunk.value);
    assert.ok(initialText.includes("event: endpoint"));

    // Activate skill via HTTP POST /mcp
    const postRes = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "load_skill",
          arguments: { skill_id: "aws_s3_upload" },
        },
      }),
    });
    assert.equal(postRes.status, 200);

    // Read SSE notification event
    const eventChunk = await reader.read();
    const eventText = decoder.decode(eventChunk.value);
    assert.ok(eventText.includes("event: message"));
    assert.ok(eventText.includes("notifications/tools/list_changed"));

    // Clean up
    controller.abort();
    await proxy.close();
  });

  test("Client end-to-end caching simulation: initial tools/list -> load_skill -> list_changed -> refreshed tools/list", async () => {
    const { interceptor } = setupTestHarness();

    // 1. Initial tools/list: only meta-tools
    const initialList = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/list",
    });
    const initialNames = initialList.result.tools.map((t: any) => t.name);
    assert.deepEqual(initialNames, ["search_skills", "load_skill", "inspect_receipt"]);

    // 2. Client sets up notification watcher
    let notificationReceived = false;
    interceptor.onNotification((notif) => {
      if (notif.method === "notifications/tools/list_changed") {
        notificationReceived = true;
      }
    });

    // 3. Client loads aws_s3_upload
    await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: { name: "load_skill", arguments: { skill_id: "aws_s3_upload" } },
    });
    assert.equal(notificationReceived, true);

    // 4. Client refreshes tools/list upon notification: aws_s3_upload is discovered!
    const refreshedList = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 103,
      method: "tools/list",
    });
    const refreshedNames = refreshedList.result.tools.map((t: any) => t.name);
    assert.ok(refreshedNames.includes("aws_s3_upload"));
    assert.equal(refreshedNames.length, 4);
  });

  test("Phase 3: HTTP MCP endpoint returns HTTP 204 No Content for incoming notifications without id", async () => {
    const { interceptor } = setupTestHarness();
    const proxy = new SkillPrismProxyServer(interceptor);
    await proxy.startHttp({ port: 0 });

    const addr = proxy.getAddress();
    assert.ok(addr);
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Send initialized notification (no id)
      const initNotifRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });

      assert.equal(initNotifRes.status, 204);
      const text = await initNotifRes.text();
      assert.equal(text, "");

      // 2. Send cancelled notification with null id
      const cancelNotifRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          method: "notifications/cancelled",
          params: { requestId: "abc-123" },
        }),
      });

      assert.equal(cancelNotifRes.status, 204);
      const cancelText = await cancelNotifRes.text();
      assert.equal(cancelText, "");

      // 3. Regular request with id must return 200 with JSON body
      const reqRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/list",
        }),
      });

      assert.equal(reqRes.status, 200);
      const json = await reqRes.json();
      assert.equal(json.id, 42);
      assert.ok(Array.isArray(json.result.tools));
    } finally {
      await proxy.close();
    }
  });

  test("Phase 3: McpProtocolInterceptor handles arbitrary notifications/* methods without -32601 error", async () => {
    const { interceptor } = setupTestHarness();

    const progressRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 201,
      method: "notifications/progress",
      params: { progress: 50, total: 100 },
    });

    assert.equal(progressRes.id, 201);
    assert.ok(!progressRes.error);

    const cancelRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 202,
      method: "$/cancelRequest",
      params: { id: 100 },
    });

    assert.equal(cancelRes.id, 202);
    assert.ok(!cancelRes.error);
  });
});
