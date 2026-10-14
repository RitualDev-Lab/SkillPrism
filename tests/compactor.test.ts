import assert from "node:assert/strict";
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
      compactor
    );

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
});
