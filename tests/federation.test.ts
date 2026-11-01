import assert from "node:assert";
import { describe, it } from "node:test";
import { FederatedSkillRegistry, LocalPeerBusTransport } from "../src/federation.js";
import type { SkillDefinition } from "../src/types.js";
import type { SemanticReceipt } from "../src/compactor.js";

describe("SkillPrism Multi-Agent Federated Skill Registry Suite", () => {
  it("initializes peer nodes and tracks active heartbeats", async () => {
    const transport = new LocalPeerBusTransport();
    const registry = new FederatedSkillRegistry("agent-alpha", "coding-agent", transport);
    await registry.initialize();

    const peers = registry.getActivePeers();
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].nodeId, "agent-alpha");
    assert.strictEqual(peers[0].agentRole, "coding-agent");

    await registry.close();
  });

  it("publishes and synchronizes skills across multiple agents in the fleet", async () => {
    const transport = new LocalPeerBusTransport();
    const agentA = new FederatedSkillRegistry("agent-A", "research-agent", transport);
    const agentB = new FederatedSkillRegistry("agent-B", "coder-agent", transport);

    await agentA.initialize();
    await agentB.initialize();

    const newSkill: SkillDefinition = {
      id: "snowflake_warehouse_query",
      name: "Snowflake Query",
      summary: "Executes queries on Snowflake cloud data warehouse",
      description: "Discovered tool for enterprise analytics.",
      category: "database",
      tags: ["snowflake", "sql"],
      parameters: [{ name: "query", type: "string", description: "SQL query" }],
    };

    await agentA.publishSkill(newSkill);

    const bSkills = agentB.getFederatedSkills();
    assert.strictEqual(bSkills.length, 1);
    assert.strictEqual(bSkills[0].id, "snowflake_warehouse_query");
    assert.strictEqual(bSkills[0].name, "Snowflake Query");

    await agentA.close();
    await agentB.close();
  });

  it("records and aggregates tool execution latency and success rates across fleet", async () => {
    const transport = new LocalPeerBusTransport();
    const agentA = new FederatedSkillRegistry("agent-A", "tester", transport);
    const agentB = new FederatedSkillRegistry("agent-B", "deployer", transport);

    await agentA.initialize();
    await agentB.initialize();

    // Agent A runs tool twice
    await agentA.recordBenchmark("postgres_query", 20, true, 200);
    await agentA.recordBenchmark("postgres_query", 40, true, 300);

    // Agent B runs tool once with an error
    await agentB.recordBenchmark("postgres_query", 60, false, 0);

    const benchA = agentA.getToolBenchmark("postgres_query");
    const benchB = agentB.getToolBenchmark("postgres_query");

    assert.ok(benchA);
    assert.ok(benchB);
    assert.strictEqual(benchA?.totalCalls, 3);
    assert.strictEqual(benchA?.avgLatencyMs, 40); // (20 + 40 + 60) / 3 = 40ms
    assert.strictEqual(benchA?.minLatencyMs, 20);
    assert.strictEqual(benchA?.maxLatencyMs, 60);
    assert.strictEqual(benchA?.successRate, 0.67); // 2 out of 3 = 0.67
    assert.strictEqual(benchA?.totalTokensSaved, 500);

    await agentA.close();
    await agentB.close();
  });

  it("shares out-of-context semantic receipts across distributed agent nodes", async () => {
    const transport = new LocalPeerBusTransport();
    const agentA = new FederatedSkillRegistry("agent-1", "worker", transport);
    const agentB = new FederatedSkillRegistry("agent-2", "verifier", transport);

    await agentA.initialize();
    await agentB.initialize();

    const sampleReceipt: SemanticReceipt = {
      ref: "receipt:fed_78a1b2c3",
      tool: "large_db_dump",
      summary: "500 rows retrieved",
      keyFields: { totalRows: 500, status: "completed" },
      status: "success",
      rawBytes: 65536,
      tokensSaved: 16000,
      timestamp: new Date().toISOString(),
    };

    await agentA.shareReceipt(sampleReceipt);

    const retrievedOnB = agentB.getSharedReceipt("receipt:fed_78a1b2c3");
    assert.ok(retrievedOnB);
    assert.strictEqual(retrievedOnB?.ref, "receipt:fed_78a1b2c3");
    assert.strictEqual(retrievedOnB?.tool, "large_db_dump");
    assert.strictEqual(retrievedOnB?.tokensSaved, 16000);

    await agentA.close();
    await agentB.close();
  });
});
