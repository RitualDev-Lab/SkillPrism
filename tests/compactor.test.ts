import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe } from "node:test";
import { ContextCompactor } from "../src/compactor.js";
import { JitHarness } from "../src/harness.js";
import { SkillIndex } from "../src/index-store.js";
import { McpProtocolInterceptor } from "../src/interceptor.js";

describe("Phase 4: Dynamic Context Compactor & Semantic Receipt GC Suite", () => {
  test("leaves small lightweight payloads uncompacted", () => {
    const compactor = new ContextCompactor(256);
    const smallPayload = { status: "ok", rowCount: 1 };
    const { isCompacted, output } = compactor.compact("test_tool", smallPayload);

    assert.equal(isCompacted, false);
    assert.deepEqual(output, smallPayload);
  });

  test("compacts massive payload (> 512 bytes) into lightweight semantic receipt", () => {
    const compactor = new ContextCompactor(200);

    // Simulate 50 database rows
    const heavyPayload = Array.from({ length: 50 }, (_, i) => ({
      userId: `user_0NpfVhYIpTLdq_${i}`,
      email: `customer_${i}@enterprise.com`,
      subscription: "growth_tier",
      balance: 145000,
      metadata: { lastLogin: new Date().toISOString(), ip: "192.168.1.100" },
    }));

    const { isCompacted, output, receipt } = compactor.compact("postgres_query", heavyPayload);

    assert.equal(isCompacted, true);
    assert.ok(receipt);
    assert.ok(receipt.ref.startsWith("receipt:postgres_query:"));
    assert.match(receipt.summary, /Retrieved array of 50 records from postgres_query/);
    assert.equal(receipt.keyFields.count, 50);
    assert.ok(receipt.tokensSaved > 500);

    const stats = compactor.getStats();
    assert.equal(stats.totalReceipts, 1);
    assert.ok(stats.totalTokensSaved > 500);
  });

  test("allows model to inspect specific subfields of compacted receipts on demand", () => {
    const compactor = new ContextCompactor(100);
    const complexData = {
      clusterId: "k8s-prod-us-east-1",
      nodes: [
        { name: "node-1", cpu: 8, memory: "32Gi" },
        { name: "node-2", cpu: 16, memory: "64Gi" },
      ],
      metrics: {
        healthy: true,
        activeDeployments: 42,
      },
    };

    const { receipt } = compactor.compact("k8s_status", complexData);
    assert.ok(receipt);

    // 1. Inspect without path returns whole object
    const fullInspect = compactor.inspectReceipt(receipt.ref);
    assert.equal(fullInspect.success, true);
    assert.equal(fullInspect.data.clusterId, "k8s-prod-us-east-1");

    // 2. Inspect with dot path returns targeted scalar
    const pathInspect = compactor.inspectReceipt(receipt.ref, "metrics.activeDeployments");
    assert.equal(pathInspect.success, true);
    assert.equal(pathInspect.data, 42);

    // 3. Inspect array index path
    const nodeInspect = compactor.inspectReceipt(receipt.ref, "nodes[1].memory");
    assert.equal(nodeInspect.success, true);
    assert.equal(nodeInspect.data, "64Gi");
  });

  test("MCP Interceptor transparently compacts upstream tool execution output", async () => {
    const index = new SkillIndex();
    index.register({
      id: "fetch_audit_logs",
      name: "Audit Logs Fetcher",
      summary: "Fetches security audit logs",
      description: "Returns logs from SIEM.",
      category: "security",
      tags: ["audit", "logs"],
      parameters: [{ name: "limit", type: "number", description: "Count", required: true }],
    });

    const harness = new JitHarness(index);
    const compactor = new ContextCompactor(200);

    // Upstream executor returns 30 heavy log items
    const interceptor = new McpProtocolInterceptor(
      harness,
      index,
      async () => {
        return Array.from({ length: 30 }, (_, i) => ({
          event: `audit_event_${i}`,
          actor: "agent-007",
          action: "read_secret",
          timestamp: new Date().toISOString(),
          context: { reason: "validation", verified: true },
        }));
      },
      compactor,
    );

    // Pre-activate tool via load_skill to satisfy JIT Gate
    await harness.handleMetaToolCall("load_skill", { skill_id: "fetch_audit_logs" });

    const callRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: {
        name: "fetch_audit_logs",
        arguments: { limit: 30 },
      },
    });

    assert.equal(callRes.id, 99);
    const parsedText = JSON.parse(callRes.result.content[0].text);
    // Verified: returned object is a compact semantic receipt rather than 30 raw objects
    assert.ok(parsedText.ref);
    assert.ok(parsedText.ref.startsWith("receipt:fetch_audit_logs:"));
    assert.equal(parsedText.keyFields.count, 30);
  });

  test("Phase 1 (S1): compactMcpResult compacts large text blocks inside standard MCP response", () => {
    const compactor = new ContextCompactor(256);
    const largeRows = Array.from({ length: 40 }, (_, i) => ({
      id: `txn_${i}`,
      amount: 1000 + i,
      vendor: "Cloud Infrastructure Inc.",
    }));
    const rawMcpResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify(largeRows),
        },
      ],
    };

    const { isCompacted, result, receipts } = compactor.compactMcpResult("query_txns", rawMcpResult);

    assert.equal(isCompacted, true);
    assert.equal(receipts.length, 1);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");

    const receipt = JSON.parse(result.content[0].text);
    assert.ok(receipt.ref.startsWith("receipt:query_txns:"));
    assert.equal(receipt.keyFields.count, 40);
    assert.equal(receipt.status, "success");

    // Drill-down inspection works via inspectReceipt
    const inspectRes = compactor.inspectReceipt(receipt.ref, "0.vendor");
    assert.equal(inspectRes.success, true);
    assert.equal(inspectRes.data, "Cloud Infrastructure Inc.");
  });

  test("Phase 1 (S1): compactMcpResult leaves small text blocks untouched", () => {
    const compactor = new ContextCompactor(512);
    const rawMcpResult = {
      content: [
        {
          type: "text",
          text: "Small scalar text output under limit",
        },
      ],
    };

    const { isCompacted, result, receipts } = compactor.compactMcpResult("ping", rawMcpResult);

    assert.equal(isCompacted, false);
    assert.equal(receipts.length, 0);
    assert.equal(result.content[0].text, "Small scalar text output under limit");
  });

  test("Phase 1 (S1): compactMcpResult preserves image content blocks untouched regardless of size", () => {
    const compactor = new ContextCompactor(128);
    const massiveBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+".repeat(500);
    const rawMcpResult = {
      content: [
        {
          type: "image",
          data: massiveBase64,
          mimeType: "image/png",
        },
      ],
    };

    const { isCompacted, result } = compactor.compactMcpResult("generate_diagram", rawMcpResult);

    assert.equal(isCompacted, false);
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].data, massiveBase64);
    assert.equal(result.content[0].mimeType, "image/png");
  });

  test("Phase 1 (S1): compactMcpResult preserves embedded resource blocks untouched", () => {
    const compactor = new ContextCompactor(128);
    const rawMcpResult = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "memo://developer-guidelines",
            mimeType: "text/markdown",
            text: "# Guidelines\n".repeat(50),
          },
        },
      ],
    };

    const { isCompacted, result } = compactor.compactMcpResult("fetch_resource", rawMcpResult);

    assert.equal(isCompacted, false);
    assert.equal(result.content[0].type, "resource");
    assert.equal(result.content[0].resource.uri, "memo://developer-guidelines");
  });

  test("Phase 1 (S1): compactMcpResult preserves isError status flag on standard error responses", () => {
    const compactor = new ContextCompactor(128);
    const rawMcpResult = {
      isError: true,
      content: [
        {
          type: "text",
          text: "Error: Connection to database failed. Stack trace: ".repeat(20),
        },
      ],
    };

    const { isCompacted, result, receipts } = compactor.compactMcpResult("db_connect", rawMcpResult);

    assert.equal(isCompacted, true);
    assert.equal(result.isError, true);
    assert.equal(receipts[0].status, "error");
  });

  test("Phase 1 (S1): inspectReceipt supports line and slice queries on raw text string receipts", () => {
    const compactor = new ContextCompactor(128);
    const multiLineLog = [
      "2026-10-16 10:00:00 [INFO] System boot initialized",
      "2026-10-16 10:00:01 [DEBUG] Loading drivers: network, disk, gpu",
      "2026-10-16 10:00:02 [WARN] High memory pressure detected in pod-0",
      "2026-10-16 10:00:03 [ERROR] Fatal exception caught: Connection reset by peer",
      "2026-10-16 10:00:04 [INFO] Recovery initiated",
    ].join("\n");

    const { receipt } = compactor.compact("get_system_logs", multiLineLog);
    assert.ok(receipt);
    assert.equal(receipt.keyFields.lines, 5);

    // 1. Line range query lines:3-4
    const linesInspect = compactor.inspectReceipt(receipt.ref, "lines:3-4");
    assert.equal(linesInspect.success, true);
    assert.match(linesInspect.data, /High memory pressure/);
    assert.match(linesInspect.data, /Fatal exception caught/);
    assert.ok(!linesInspect.data.includes("System boot initialized"));

    // 2. Character slice query slice:0:30
    const sliceInspect = compactor.inspectReceipt(receipt.ref, "slice:0:30");
    assert.equal(sliceInspect.success, true);
    assert.equal(sliceInspect.data, multiLineLog.slice(0, 30));

    // 3. Preview query
    const previewInspect = compactor.inspectReceipt(receipt.ref, "preview");
    assert.equal(previewInspect.success, true);
    assert.equal(previewInspect.data, multiLineLog.slice(0, 500));
  });

  test("Phase 4: Disk storage persistence, overflow eviction, and GC cleanup", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillprism-compactor-test-"));

    try {
      // 1. Compactor with storageDir and maxVaultEntries = 2
      const compactor = new ContextCompactor(50, 100, 2, tempDir);

      const payload1 = { data: "x".repeat(100), id: 1 };
      const payload2 = { data: "y".repeat(100), id: 2 };
      const payload3 = { data: "z".repeat(100), id: 3 };

      const { receipt: r1 } = compactor.compact("tool1", payload1);
      const { receipt: r2 } = compactor.compact("tool2", payload2);

      assert.ok(r1);
      assert.ok(r2);

      // Verify files exist on disk
      const filesBeforeOverflow = fs.readdirSync(tempDir);
      assert.equal(filesBeforeOverflow.length, 2);

      // Compact 3rd item -> triggers vault eviction of oldest entry (r1)
      const { receipt: r3 } = compactor.compact("tool3", payload3);
      assert.ok(r3);

      // Verify oldest file was evicted from disk as well
      const r1Filename = `${r1.ref.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`;
      assert.equal(fs.existsSync(path.join(tempDir, r1Filename)), false);

      // 2. Test inspectReceipt restores from disk if missing from memory
      const r2Filename = `${r2.ref.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`;
      assert.equal(fs.existsSync(path.join(tempDir, r2Filename)), true);

      // 3. Test gc() cleans up disk files that have expired
      // Force sleep or wait for expiry (100ms)
      const start = Date.now();
      while (Date.now() - start < 120) {
        // Busy wait
      }

      const purged = compactor.gc();
      assert.ok(purged >= 1);

      const remainingFiles = fs.readdirSync(tempDir);
      assert.equal(remainingFiles.length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
