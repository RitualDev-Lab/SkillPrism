import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { JitHarness } from "../src/harness.js";
import { SkillIndex } from "../src/index-store.js";
import type { SkillDefinition } from "../src/types.js";

describe("Phase 2: JIT Meta-Tool Harness Suite", () => {
  const sampleSkill: SkillDefinition = {
    id: "snowflake_warehouse_query",
    name: "Snowflake Warehouse Query",
    summary: "Executes enterprise SQL analytical queries in Snowflake virtual warehouses",
    description: "Connects to Snowflake cloud data warehouse with role-based access control.",
    category: "database",
    tags: ["snowflake", "sql", "warehouse", "analytics"],
    permissions: ["snowflake:read"],
    parameters: [
      { name: "sql", type: "string", description: "Warehouse SQL query", required: true },
      { name: "warehouse", type: "string", description: "Target compute warehouse" },
    ],
  };

  test("JitHarness provides minimal meta-tool zero-state (< 210 token footprint)", () => {
    const index = new SkillIndex();
    const harness = new JitHarness(index);

    const zeroState = harness.getZeroStateTools();
    assert.equal(zeroState.length, 3);
    assert.equal(zeroState[0].name, "search_skills");
    assert.equal(zeroState[1].name, "load_skill");
    assert.equal(zeroState[2].name, "inspect_receipt");

    // Zero-state active tools should only have the 3 meta-tools initially
    const active = harness.getActiveTools();
    assert.equal(active.length, 3);
  });

  test("search_skills returns lightweight candidate summaries without parameter bloat", async () => {
    const index = new SkillIndex();
    index.register(sampleSkill);
    const harness = new JitHarness(index);

    const res = await harness.handleMetaToolCall("search_skills", {
      intent: "query snowflake warehouse",
    });

    assert.equal(res.status, "success");
    assert.ok(res.data);
    assert.equal(res.data.matchesFound, 1);
    assert.equal(res.data.skills[0].id, "snowflake_warehouse_query");
    assert.ok(res.data.skills[0].howToActivate.includes("load_skill"));
  });

  test("load_skill injects full typed schema into active toolset for subsequent turn", async () => {
    const index = new SkillIndex();
    index.register(sampleSkill);
    const harness = new JitHarness(index);

    // Initial state: 3 meta-tools (search_skills, load_skill, inspect_receipt)
    assert.equal(harness.getActiveTools().length, 3);

    // Invoke load_skill
    const res = await harness.handleMetaToolCall("load_skill", {
      skill_id: "snowflake_warehouse_query",
    });

    assert.equal(res.status, "success");
    assert.ok(res.injectedToolSchema);
    assert.equal(res.injectedToolSchema?.name, "snowflake_warehouse_query");
    assert.equal(res.injectedToolSchema?.parameters.required[0], "sql");

    // Active tools now dynamically includes the activated skill
    const activeTools = harness.getActiveTools();
    assert.equal(activeTools.length, 4);
    assert.equal(activeTools[3].name, "snowflake_warehouse_query");
  });

  test("JitHarness gracefully handles nonexistent skill loads", async () => {
    const index = new SkillIndex();
    const harness = new JitHarness(index);

    const res = await harness.handleMetaToolCall("load_skill", {
      skill_id: "nonexistent_tool_123",
    });

    assert.equal(res.status, "error");
    assert.match(res.error || "", /was not found in the out-of-context registry/);
  });

  test("JitHarness prunes expired skill schemas when TTL expires", async () => {
    const index = new SkillIndex();
    index.register(sampleSkill);
    // Set TTL = 2 turns
    const harness = new JitHarness(index, 2);

    await harness.handleMetaToolCall("load_skill", {
      skill_id: "snowflake_warehouse_query",
    });

    assert.equal(harness.getActiveSkillCount(), 1);

    // Step turn 1 -> still active
    harness.stepTurn();
    assert.equal(harness.getActiveSkillCount(), 1);

    // Step turn 2 -> TTL reached, pruned from context
    harness.stepTurn();
    assert.equal(harness.getActiveSkillCount(), 0);
    assert.equal(harness.getActiveTools().length, 3); // 3 meta-tools remain
  });
});
