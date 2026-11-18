/**
 * Reproducible SkillPrism Token Compaction Benchmark
 *
 * Compares 5 strategies using real BPE tokenization (gpt-tokenizer):
 * 1. Raw Tool Schemas (Baseline — all schemas preloaded every turn)
 * 2. Native OpenAI Prompt Caching (50% cache read discount on static full catalog)
 * 3. Native Anthropic Prompt Caching (90% cache read discount on static full catalog)
 * 4. SkillPrism JIT Receipts (3 zero-state meta-tools + JIT loading + semantic receipts)
 * 5. SkillPrism + Native Anthropic Prompt Caching (Stacked FinOps)
 *
 * Run directly: npx tsx benchmarks/token-compaction.ts
 */

import { BenchmarkEngine } from "../src/benchmark.js";
import { PromptCacheStack } from "../src/prompt-cache-stack.js";
import type { SkillDefinition } from "../src/types.js";

export interface StrategyBenchmarkRow {
  strategy: string;
  effectiveTokens: number;
  reductionVsRawPercent: number;
  estimatedCostUsdPer1000Sessions: number;
}

export interface TokenCompactionBenchmarkReport {
  catalogSize: number;
  turnsPerSession: number;
  costPerMillionInputTokensUsd: number;
  rows: StrategyBenchmarkRow[];
  generatedAt: string;
}

export function buildSyntheticMcpCatalog(count = 50): SkillDefinition[] {
  const categories = ["database", "cloud", "vcs", "observability", "payments", "security"];
  return Array.from({ length: count }, (_, idx) => {
    const category = categories[idx % categories.length];
    return {
      id: `${category}_tool_${idx + 1}`,
      name: `${category}_execute_action_${idx + 1}`,
      description: `Enterprise ${category} MCP tool #${idx + 1} for inspecting, querying, and managing ${category} resources with strict RBAC audit logging.`,
      category,
      tags: [category, "mcp", "enterprise", "tool"],
      parameters: [
        {
          name: "target",
          type: "string",
          description: `Target ${category} resource identifier`,
          required: true,
        },
        {
          name: "filter",
          type: "string",
          description: "Optional structured query filter expression",
          required: false,
        },
        {
          name: "limit",
          type: "number",
          description: "Maximum number of items returned (default 50)",
          required: false,
        },
        {
          name: "dryRun",
          type: "boolean",
          description: "Preview impact without mutating live state",
          required: false,
        },
      ],
    };
  });
}

export async function runTokenCompactionBenchmark(options?: {
  catalogSize?: number;
  turnsPerSession?: number;
  costPerMillionTokens?: number;
}): Promise<TokenCompactionBenchmarkReport> {
  const catalogSize = options?.catalogSize ?? 50;
  const turnsPerSession = options?.turnsPerSession ?? 5;
  const costPerMillion = options?.costPerMillionTokens ?? 3.0;

  const catalog = buildSyntheticMcpCatalog(catalogSize);
  const trajectory = await BenchmarkEngine.runTrajectoryBenchmark(catalog, {
    totalTurns: turnsPerSession,
    searchQuery: "database execute query resource",
    targetToolId: catalog[0].id,
    resultRowCount: 50,
  });

  const rawTotal = trajectory.monolithicTotalTokens;
  const schemaPerTurn = trajectory.monolithicSchemaTokensPerTurn;
  const rawPayload = trajectory.monolithicRawPayloadTokens;

  // Native OpenAI prompt caching: Turn 1 uncached (1.0x), Turns 2..N cached at 0.50x; payload still uncompacted
  const openAiCachedTotal = Math.round(
    schemaPerTurn + schemaPerTurn * (turnsPerSession - 1) * 0.5 + rawPayload,
  );

  // Native Anthropic prompt caching: Turn 1 write (1.25x), Turns 2..N read (0.10x); payload still uncompacted
  const anthropicCachedTotal = Math.round(
    schemaPerTurn * 1.25 + schemaPerTurn * (turnsPerSession - 1) * 0.1 + rawPayload,
  );

  // SkillPrism JIT Receipts only (no provider prompt caching)
  const skillPrismJitTotal = trajectory.skillPrismTotalTokens;

  // SkillPrism + Native Anthropic Prompt Caching stacked on zero-state & active tool prefixes
  const stack = new PromptCacheStack({ provider: "anthropic" });
  const stackedStats = stack.calculateStackedSavings(
    rawTotal,
    skillPrismJitTotal,
    0.8, // 80% prefix cache hit across multi-turn session
    costPerMillion,
  );
  const stackedTotal = stackedStats.effectiveCachedTokens;

  const toRow = (strategy: string, tokens: number): StrategyBenchmarkRow => {
    const reduction = Number((((rawTotal - tokens) / rawTotal) * 100).toFixed(2));
    const cost1000 = Number(((tokens * 1000 * costPerMillion) / 1_000_000).toFixed(2));
    return {
      strategy,
      effectiveTokens: tokens,
      reductionVsRawPercent: reduction,
      estimatedCostUsdPer1000Sessions: cost1000,
    };
  };

  return {
    catalogSize,
    turnsPerSession,
    costPerMillionInputTokensUsd: costPerMillion,
    rows: [
      toRow("1. Raw Tool Schemas (Baseline)", rawTotal),
      toRow("2. Native OpenAI Prompt Caching (50% read)", openAiCachedTotal),
      toRow("3. Native Anthropic Prompt Caching (90% read)", anthropicCachedTotal),
      toRow("4. SkillPrism JIT Receipts Only", skillPrismJitTotal),
      toRow("5. SkillPrism + Anthropic Prompt Caching (Stacked)", stackedTotal),
    ],
    generatedAt: new Date().toISOString(),
  };
}

const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("benchmarks/token-compaction.ts");

if (isDirectExecution) {
  runTokenCompactionBenchmark().then((report) => {
    console.log(
      `\n⚡ SkillPrism Reproducible Token Compaction Benchmark (${report.catalogSize} MCP tools, ${report.turnsPerSession} turns, $${report.costPerMillionInputTokensUsd}/1M tokens)\n`,
    );
    console.table(report.rows);
  });
}
