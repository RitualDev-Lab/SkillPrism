import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { JitHarness } from "../src/harness.js";
import { SkillIndex } from "../src/index-store.js";
import { type JsonRpcNotification, McpProtocolInterceptor } from "../src/interceptor.js";
import { SkillPrismProxyServer } from "../src/proxy-server.js";

describe("Phase 4 (S4): Turn & Time-Based Gateway Lifecycle & Expiration Wiring Suite", () => {
  function setupTestEnvironment(ttlTurns = 2, idleTtlMs = 1000 * 60) {
    const index = new SkillIndex();
    index.register({
      id: "postgres_query",
      name: "PostgreSQL Query Exec",
      summary: "Executes parameterized read queries",
      description: "Performs read-only SQL queries.",
      category: "database",
      tags: ["sql", "postgres"],
      parameters: [{ name: "sql", type: "string", description: "SQL query", required: true }],
    });
    index.register({
      id: "aws_s3_upload",
      name: "AWS S3 Upload",
      summary: "Uploads files to S3",
      description: "Uploads objects to bucket.",
      category: "cloud",
      tags: ["aws", "s3"],
      parameters: [{ name: "bucket", type: "string", description: "Bucket", required: true }],
    });

    const harness = new JitHarness(index, ttlTurns, idleTtlMs);
    let executionCount = 0;
    const interceptor = new McpProtocolInterceptor(harness, index, async (name, args) => {
      executionCount++;
      return { status: "ok", count: executionCount, tool: name, args };
    });

    return { index, harness, interceptor, getExecutionCount: () => executionCount };
  }

  test("Gateway turn accounting: tool execution steps turns and automatically expires tool after TTL", async () => {
    // TTL = 2 turns
    const { interceptor, harness } = setupTestEnvironment(2);

    // Initial state: turn 1, 0 active skills
    assert.equal(harness.getCurrentTurn(), 1);
    assert.equal(harness.getActiveSkillCount(), 0);

    // 1. Activate postgres_query in turn 1 (expires at turn 1 + 2 = 3)
    await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "load_skill", arguments: { skill_id: "postgres_query" } },
    });
    assert.equal(harness.getCurrentTurn(), 1); // load_skill does not advance turn
    assert.equal(harness.getActiveSkillCount(), 1);

    // 2. First tool execution (turn 1 -> steps to turn 2)
    const callRes1 = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "postgres_query", arguments: { sql: "SELECT 1" } },
    });
    assert.equal(callRes1.id, 2);
    assert.equal(harness.getCurrentTurn(), 2);
    assert.equal(harness.getActiveSkillCount(), 1); // still active on turn 2

    // 3. Second tool execution (turn 2 -> steps to turn 3)
    // Turn 3 reaches expiresAtTurn=3, so skill expires!
    const callRes2 = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "postgres_query", arguments: { sql: "SELECT 2" } },
    });
    assert.equal(callRes2.id, 3);
    assert.equal(harness.getCurrentTurn(), 3);
    assert.equal(harness.getActiveSkillCount(), 0); // successfully expired!

    // 4. Third tool execution: rejected by JIT Gate Block because it expired
    const callRes3 = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "postgres_query", arguments: { sql: "SELECT 3" } },
    });
    assert.equal(callRes3.id, 4);
    assert.ok(callRes3.error);
    assert.equal(callRes3.error.code, -32002);
    assert.match(callRes3.error.message, /JIT Gate Block/);
  });

  test("Expiration triggers notifications/tools/list_changed and removes tool from tools/list", async () => {
    const { interceptor, harness } = setupTestEnvironment(1); // TTL = 1 turn

    const notifications: JsonRpcNotification[] = [];
    interceptor.onNotification((notif) => {
      notifications.push(notif);
    });

    // 1. Activate tool (notification 1)
    await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "load_skill", arguments: { skill_id: "postgres_query" } },
    });
    assert.equal(notifications.length, 1);

    // Verify it is present in tools/list
    const listBefore = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
    });
    const namesBefore = listBefore.result.tools.map((t: any) => t.name);
    assert.ok(namesBefore.includes("postgres_query"));

    // 2. Execute tool (TTL=1 -> expires immediately upon stepping, notification 2 emitted)
    await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "postgres_query", arguments: { sql: "SELECT 1" } },
    });
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].method, "notifications/tools/list_changed");

    // Verify it is no longer present in tools/list
    const listAfter = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/list",
    });
    const namesAfter = listAfter.result.tools.map((t: any) => t.name);
    assert.ok(!namesAfter.includes("postgres_query"));
  });

  test("Wall-clock time expiration: skill expires when idle duration exceeds idleTtlMs", async () => {
    // 50ms idle TTL
    const { interceptor, harness } = setupTestEnvironment(10, 50);

    await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "load_skill", arguments: { skill_id: "aws_s3_upload" } },
    });
    assert.equal(harness.getActiveSkillCount(), 1);

    // Wait 60ms so idle TTL expires
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Calling pruneExpiredSkills should prune the time-expired tool
    const pruned = harness.pruneExpiredSkills();
    assert.equal(pruned, 1);
    assert.equal(harness.getActiveSkillCount(), 0);
  });

  test("Proxy idle sweep timer automatically prunes idle tools and broadcasts notification", async () => {
    const { interceptor, harness } = setupTestEnvironment(10, 50);
    const proxy = new SkillPrismProxyServer(interceptor);

    const notifications: JsonRpcNotification[] = [];
    interceptor.onNotification((notif) => {
      notifications.push(notif);
    });

    // Start fast sweep timer (every 20ms)
    proxy.startIdleSweep(20);

    // Activate tool (notification 1)
    await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "load_skill", arguments: { skill_id: "aws_s3_upload" } },
    });
    assert.equal(notifications.length, 1);
    assert.equal(harness.getActiveSkillCount(), 1);

    // Wait 80ms for idle TTL and background sweep to trigger
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Tool should have been pruned automatically by the proxy sweep timer!
    assert.equal(harness.getActiveSkillCount(), 0);
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].method, "notifications/tools/list_changed");

    await proxy.close();
  });

  test("setAutoStepTurns(false) keeps turn static until manual step", async () => {
    const { interceptor, harness } = setupTestEnvironment(2);
    interceptor.setAutoStepTurns(false);

    await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "load_skill", arguments: { skill_id: "postgres_query" } },
    });
    assert.equal(harness.getCurrentTurn(), 1);

    // Execute 5 times: turn should remain 1 because auto-stepping is disabled
    for (let i = 0; i < 5; i++) {
      await interceptor.handleMessage({
        jsonrpc: "2.0",
        id: 41 + i,
        method: "tools/call",
        params: { name: "postgres_query", arguments: { sql: "SELECT 1" } },
      });
    }

    assert.equal(harness.getCurrentTurn(), 1);
    assert.equal(harness.getActiveSkillCount(), 1);

    // Manually step turn
    harness.stepTurn();
    harness.stepTurn();
    assert.equal(harness.getActiveSkillCount(), 0); // now expired
  });
});
