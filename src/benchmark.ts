import { ContextCompactor } from "./compactor.js";
import { JitHarness } from "./harness.js";
import { SkillIndex } from "./index-store.js";
import type { SkillDefinition } from "./types.js";

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
 * Quantifies exact token reductions, context preservation, and latency.
 */
export class BenchmarkEngine {
  public static runComparison(sampleCatalog: SkillDefinition[]): BenchmarkMetrics {
    const index = new SkillIndex();
    index.registerBatch(sampleCatalog);

    const harness = new JitHarness(index);
    const compactor = new ContextCompactor(256);

    // 1. Calculate unoptimized zero-state tokens (preloading all schemas upfront)
    let unoptimizedTokens = 0;
    for (const skill of sampleCatalog) {
      const rawText = JSON.stringify(harness.convertToToolDefinition(skill));
      unoptimizedTokens += Math.ceil(rawText.length / 3.8);
    }

    // 2. Calculate SkillPrism zero-state tokens (only 2 meta-tools)
    const zeroStateTools = harness.getZeroStateTools();
    const zeroStateText = JSON.stringify(zeroStateTools);
    const skillPrismZeroTokens = Math.ceil(zeroStateText.length / 3.8);

    const tokenSavingsPercentage = Number(
      (((unoptimizedTokens - skillPrismZeroTokens) / unoptimizedTokens) * 100).toFixed(1)
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
      (((uncompactedBytes - compactedBytes) / uncompactedBytes) * 100).toFixed(1)
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
}
