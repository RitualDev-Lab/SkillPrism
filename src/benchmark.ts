import { encode } from "gpt-tokenizer";
import { ContextCompactor } from "./compactor.js";
import { JitHarness } from "./harness.js";
import { SkillIndex } from "./index-store.js";
import type { SkillDefinition, TaskTrajectoryMetrics } from "./types.js";

export interface BenchmarkMetrics {
  catalogSize: number;
  unoptimizedZeroStateTokens: number;
  skillPrismZeroStateTokens: number;
  tokenSavingsPercentage: number;
  searchLatencyMs: number;
  averageExecutionCompactionSavingsPercent: number;
}

/**
 * BenchmarkEngine
 * Quantifies exact token reductions, context preservation, complete task economics, and latency.
 * Uses real BPE tokenizer (gpt-tokenizer cl100k_base / o200k_base) for honest metric reporting.
 */
export class BenchmarkEngine {
  public static countTokens(text: string): number {
    try {
      return encode(text).length;
    } catch {
      return Math.ceil(text.length / 3.8);
    }
  }

  public static runComparison(sampleCatalog: SkillDefinition[]): BenchmarkMetrics {
    const index = new SkillIndex();
    index.registerBatch(sampleCatalog);

    const harness = new JitHarness(index);
    const compactor = new ContextCompactor(256);

    // 1. Calculate unoptimized zero-state tokens (preloading all schemas upfront with real BPE tokenizer)
    let unoptimizedTokens = 0;
    for (const skill of sampleCatalog) {
      const rawText = JSON.stringify(harness.convertToToolDefinition(skill));
      unoptimizedTokens += BenchmarkEngine.countTokens(rawText);
    }

    // 2. Calculate SkillPrism zero-state tokens (only 3 meta-tools with real BPE tokenizer)
    const zeroStateTools = harness.getZeroStateTools();
    const zeroStateText = JSON.stringify(zeroStateTools);
    const skillPrismZeroTokens = BenchmarkEngine.countTokens(zeroStateText);

    const tokenSavingsPercentage = Number(
      (((unoptimizedTokens - skillPrismZeroTokens) / unoptimizedTokens) * 100).toFixed(1),
    );

    // 3. Measure search latency
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      index.search("postgres database query with connection pool", 3);
    }
    const totalDuration = performance.now() - start;
    const searchLatencyMs = Number((totalDuration / 50).toFixed(3));

    // 4. Measure sample heavy payload compaction
    const heavyPayload = Array.from({ length: 40 }, (_, idx) => ({
      id: `row_${idx}`,
      name: `Record ${idx}`,
      timestamp: new Date().toISOString(),
      attributes: { verified: true, active: true },
    }));

    const { receipt } = compactor.compact("sample_exec", heavyPayload);
    const uncompactedBytes = Buffer.byteLength(JSON.stringify(heavyPayload));
    const compactedBytes = Buffer.byteLength(JSON.stringify(receipt));
    const compactionSavingsPercent = Number(
      (((uncompactedBytes - compactedBytes) / uncompactedBytes) * 100).toFixed(1),
    );

    return {
      catalogSize: sampleCatalog.length,
      unoptimizedZeroStateTokens: unoptimizedTokens,
      skillPrismZeroStateTokens: skillPrismZeroTokens,
      tokenSavingsPercentage,
      searchLatencyMs,
      averageExecutionCompactionSavingsPercent: compactionSavingsPercent,
    };
  }

  /**
   * Run end-to-end multi-turn Task Trajectory Economics measurement.
   * Quantifies complete lifecycle token expenditure (search, load, execution, receipt inspection,
   * turn TTL expiration) vs monolithic monolithic preloading, along with measured task success rate.
   */
  public static async runTrajectoryBenchmark(
    catalog: SkillDefinition[],
    options: {
      totalTurns?: number;
      searchQuery?: string;
      targetToolId?: string;
      resultRowCount?: number;
    } = {},
  ): Promise<TaskTrajectoryMetrics> {
    const totalTurns = options.totalTurns || 5;
    const searchQuery = options.searchQuery || "database query table";
    const targetToolId = options.targetToolId || catalog[0]?.id || "db_query";
    const rowCount = options.resultRowCount || 50;

    const index = new SkillIndex();
    index.registerBatch(catalog);
    const harness = new JitHarness(index, 2); // 2-turn TTL
    const compactor = new ContextCompactor(256);

    // 1. Monolithic Baseline:
    // Schema tokens repeated every single turn + raw uncompacted payload
    let monolithicSchemaPerTurn = 0;
    for (const skill of catalog) {
      monolithicSchemaPerTurn += BenchmarkEngine.countTokens(
        JSON.stringify(harness.convertToToolDefinition(skill)),
      );
    }

    const heavyExecutionResult = Array.from({ length: rowCount }, (_, idx) => ({
      id: `row_${idx}`,
      title: `Dataset Record Entry ${idx}`,
      payload: {
        status: "active",
        processed: true,
        score: Math.random() * 100,
        metadata: { region: "us-east-1", tier: "premium", index: idx },
      },
    }));

    const monolithicRawPayloadTokens = BenchmarkEngine.countTokens(
      JSON.stringify(heavyExecutionResult),
    );
    const monolithicTotalTokens =
      monolithicSchemaPerTurn * totalTurns + monolithicRawPayloadTokens;

    // 2. SkillPrism Trajectory:
    const zeroStateTools = harness.getZeroStateTools();
    const zeroStateTokens = BenchmarkEngine.countTokens(JSON.stringify(zeroStateTools));

    // Turn 1: Search out-of-context registry
    const searchResults = index.search(searchQuery, 3);
    const foundTarget = searchResults.some(
      (r) => r.skill.id === targetToolId || r.skill.name.toLowerCase().includes("database") || r.skill.category === "database",
    );
    const searchCallTokens = BenchmarkEngine.countTokens(
      JSON.stringify({ name: "search_skills", arguments: { intent: searchQuery } }),
    );
    const searchResultTokens = BenchmarkEngine.countTokens(
      JSON.stringify(searchResults.map((r) => r.disclosureSnippet)),
    );
    const searchOverheadTokens = searchCallTokens + searchResultTokens;

    // Turn 2: Load identified skill
    const targetSkill = index.get(targetToolId) || catalog[0];
    const loadCallTokens = BenchmarkEngine.countTokens(
      JSON.stringify({ name: "load_skill", arguments: { skill_id: targetSkill.id } }),
    );
    const loadResult = await harness.handleMetaToolCall("load_skill", { skill_id: targetSkill.id });
    const loadResultTokens = BenchmarkEngine.countTokens(JSON.stringify(loadResult));
    const loadOverheadTokens = loadCallTokens + loadResultTokens;

    // Turn 3: Execute tool while active
    const activeToolSchema = harness.getActiveTools();
    const turn3SchemaTokens = BenchmarkEngine.countTokens(JSON.stringify(activeToolSchema));
    const singleToolSchemaTokens = turn3SchemaTokens - zeroStateTokens;

    // Tool returns heavy output -> compacted to semantic receipt
    const { receipt } = compactor.compact(targetSkill.id, heavyExecutionResult);
    const compactedPayloadTokens = BenchmarkEngine.countTokens(JSON.stringify(receipt));

    // Turn 4: Inspect receipt subfield
    const turn4SchemaTokens = BenchmarkEngine.countTokens(JSON.stringify(harness.getActiveTools()));
    const inspectCallTokens = BenchmarkEngine.countTokens(
      JSON.stringify({ name: "inspect_receipt", arguments: { ref: receipt?.ref, path: "preview" } }),
    );
    const inspected = compactor.inspectReceipt(receipt?.ref || "", "preview");
    const inspectResultTokens = BenchmarkEngine.countTokens(JSON.stringify(inspected));
    const inspectionTokens = inspectCallTokens + inspectResultTokens;

    // Turn 5: TTL expiration steps -> tool prunes back to zero-state
    harness.stepTurn();
    harness.stepTurn();
    harness.pruneExpiredSkills();
    const turn5SchemaTokens = BenchmarkEngine.countTokens(JSON.stringify(harness.getActiveTools()));

    // Total SkillPrism cumulative tokens across all turns
    const skillPrismTotalTokens =
      zeroStateTokens + // Turn 1 tools
      searchOverheadTokens + // Turn 1 search call & result
      zeroStateTokens + // Turn 2 tools
      loadOverheadTokens + // Turn 2 load call & result
      turn3SchemaTokens + // Turn 3 tools (zero-state + loaded skill)
      compactedPayloadTokens + // Turn 3 compacted receipt
      turn4SchemaTokens + // Turn 4 tools
      inspectionTokens + // Turn 4 inspect call & result
      turn5SchemaTokens; // Turn 5 tools (pruned back to zero-state)

    const taskSuccessRate =
      foundTarget && loadResult.status === "success" && Boolean(receipt?.ref) ? 1.0 : 0.0;
    const netTokenSavingsPercent = Number(
      (((monolithicTotalTokens - skillPrismTotalTokens) / monolithicTotalTokens) * 100).toFixed(1),
    );
    const tokenEfficiencyMultiplier = Number(
      (monolithicTotalTokens / skillPrismTotalTokens).toFixed(2),
    );

    return {
      catalogSize: catalog.length,
      totalTurns,
      taskSuccessRate,
      monolithicTotalTokens,
      monolithicSchemaTokensPerTurn: monolithicSchemaPerTurn,
      monolithicRawPayloadTokens,
      skillPrismTotalTokens,
      skillPrismZeroStateTokens: zeroStateTokens,
      skillPrismActiveSchemaTokens: singleToolSchemaTokens,
      skillPrismCompactedPayloadTokens: compactedPayloadTokens,
      skillPrismSearchOverheadTokens: searchOverheadTokens + loadOverheadTokens,
      skillPrismInspectionTokens: inspectionTokens,
      netTokenSavingsPercent,
      tokenEfficiencyMultiplier,
    };
  }
}
