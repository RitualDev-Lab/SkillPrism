import assert from "node:assert";
import { describe, it } from "node:test";
import { ContextCompactor } from "../src/compactor.js";
import {
  ContextBudgetManager,
  computeContextBudget,
  formatDescriptionForBudget,
  inferModelContextWindow,
} from "../src/context-budget.js";
import { JitHarness } from "../src/harness.js";
import { SkillIndex } from "../src/index-store.js";
import type { SkillDefinition } from "../src/types.js";

describe("SkillPrism Context Window Dynamic Budgeting Suite", () => {
  describe("1. Host Model Capacity Inference", () => {
    it("accurately detects capacity for flagship models", () => {
      assert.strictEqual(inferModelContextWindow("claude-3-5-sonnet").capacityTokens, 200000);
      assert.strictEqual(inferModelContextWindow("gpt-4o").capacityTokens, 128000);
      assert.strictEqual(inferModelContextWindow("gemini-1.5-pro").capacityTokens, 2097152);
      assert.strictEqual(inferModelContextWindow("gemini-2.0-flash").capacityTokens, 1048576);
      assert.strictEqual(inferModelContextWindow("llama-3-8b").capacityTokens, 8192);
      assert.strictEqual(inferModelContextWindow("mistral-7b").capacityTokens, 32768);
    });

    it("respects explicit CONTEXT_WINDOW_SIZE environment variable override", () => {
      const prev = process.env.CONTEXT_WINDOW_SIZE;
      try {
        process.env.CONTEXT_WINDOW_SIZE = "65536";
        assert.strictEqual(inferModelContextWindow("unknown-custom-model").capacityTokens, 65536);
      } finally {
        if (prev !== undefined) process.env.CONTEXT_WINDOW_SIZE = prev;
        // biome-ignore lint/performance/noDelete: process.env cleanup in test
        else delete process.env.CONTEXT_WINDOW_SIZE;
      }
    });
  });

  describe("2. Dynamic Budget Computation Across Capacity Tiers", () => {
    it("computes aggressive compaction budget for tight tier (8k)", () => {
      const budget = computeContextBudget(8192, "llama-3-8b");
      assert.strictEqual(budget.tier, "compact_tight");
      assert.strictEqual(budget.compactorByteThreshold, 256);
      assert.strictEqual(budget.toolDescriptionMode, "ultra_short");
      assert.strictEqual(budget.maxActiveTools, 3);
      assert.ok(budget.reasoningReserveTokens >= 6000);
    });

    it("computes standard budget for 32k window", () => {
      const budget = computeContextBudget(32768, "qwen-2.5-coder");
      assert.strictEqual(budget.tier, "standard");
      assert.strictEqual(budget.compactorByteThreshold, 512);
      assert.strictEqual(budget.toolDescriptionMode, "concise");
      assert.strictEqual(budget.maxActiveTools, 6);
    });

    it("computes large budget for 128k - 200k windows", () => {
      const budget = computeContextBudget(128000, "gpt-4o");
      assert.strictEqual(budget.tier, "large");
      assert.strictEqual(budget.compactorByteThreshold, 2048);
      assert.strictEqual(budget.toolDescriptionMode, "standard");
      assert.strictEqual(budget.maxActiveTools, 12);
    });

    it("computes massive budget for 1M+ windows", () => {
      const budget = computeContextBudget(1048576, "gemini-1.5-flash");
      assert.strictEqual(budget.tier, "massive");
      assert.strictEqual(budget.compactorByteThreshold, 8192);
      assert.strictEqual(budget.toolDescriptionMode, "verbose");
      assert.strictEqual(budget.maxActiveTools, 25);
    });
  });

  describe("3. Dynamic Compactor & Harness Tuning", () => {
    const sampleSkill: SkillDefinition = {
      id: "test_tool",
      name: "Test Tool",
      summary: "Short summary",
      description: "Detailed description with multi-line documentation.",
      category: "database",
      tags: ["sql", "db"],
      parameters: [],
    };

    it("formats description according to active budget tier", () => {
      assert.strictEqual(formatDescriptionForBudget(sampleSkill, "ultra_short"), "Short summary");
      assert.ok(
        formatDescriptionForBudget(sampleSkill, "concise").includes("[Category: database]"),
      );
      assert.strictEqual(
        formatDescriptionForBudget(sampleSkill, "standard"),
        "Detailed description with multi-line documentation.",
      );
      assert.ok(formatDescriptionForBudget(sampleSkill, "verbose").includes("Tags: sql, db"));
    });

    it("ContextBudgetManager tunes compactor thresholds dynamically", () => {
      const compactor = new ContextCompactor(512);
      const manager = new ContextBudgetManager("llama-3-8b"); // 8k tight

      manager.tuneCompactor(compactor);
      assert.strictEqual(compactor.getMaxByteThreshold(), 256);

      manager.setCapacity(128000, "gpt-4o");
      manager.tuneCompactor(compactor);
      assert.strictEqual(compactor.getMaxByteThreshold(), 2048);
    });

    it("ContextBudgetManager tunes harness max active skills limit", () => {
      const index = new SkillIndex();
      const harness = new JitHarness(index, 3, 60000, 10);
      const manager = new ContextBudgetManager("llama-3-8b"); // 8k -> max 3 tools

      manager.tuneHarness(harness);
      assert.strictEqual(harness.getMaxActiveSkills(), 3);
    });
  });
});
