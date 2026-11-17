export interface FinOpsTurnRecord {
  originalTokens: number;
  compactedTokens: number;
  cachedTokens: number;
  latencyMs: number;
  costPerMillion?: number;
}

export interface FinOpsMetricsSnapshot {
  tokensOriginalTotal: number;
  tokensCompactedTotal: number;
  tokensCachedTotal: number;
  tokensSavedTotal: number;
  computeDollarsSavedTotal: number;
  compactionRatio: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p99LatencyMs: number;
  turnsRecorded: number;
}

export class FinOpsMetricsExporter {
  private tokensOriginalTotal = 0;
  private tokensCompactedTotal = 0;
  private tokensCachedTotal = 0;
  private computeDollarsSavedTotal = 0;
  private latencies: number[] = [];
  private readonly maxReservoirSize = 1000;

  public recordTurn(record: FinOpsTurnRecord): void {
    const costPerMillion = record.costPerMillion ?? 3.0; // default $3 / 1M tokens
    this.tokensOriginalTotal += record.originalTokens;
    this.tokensCompactedTotal += record.compactedTokens;
    this.tokensCachedTotal += record.cachedTokens;

    const tokensSaved = Math.max(0, record.originalTokens - record.compactedTokens);
    const dollarsSaved = (tokensSaved / 1_000_000) * costPerMillion;
    this.computeDollarsSavedTotal += dollarsSaved;

    this.latencies.push(record.latencyMs);
    if (this.latencies.length > this.maxReservoirSize) {
      this.latencies.shift();
    }
  }

  public getSnapshot(): FinOpsMetricsSnapshot {
    const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
    const count = sortedLatencies.length;

    const p50 = count > 0 ? sortedLatencies[Math.floor(count * 0.5)] : 0;
    const p90 = count > 0 ? sortedLatencies[Math.floor(count * 0.9)] : 0;
    const p99 = count > 0 ? sortedLatencies[Math.floor(count * 0.99)] : 0;

    const tokensSaved = Math.max(0, this.tokensOriginalTotal - this.tokensCompactedTotal);
    const compactionRatio =
      this.tokensOriginalTotal > 0
        ? tokensSaved / this.tokensOriginalTotal
        : 0;

    return {
      tokensOriginalTotal: this.tokensOriginalTotal,
      tokensCompactedTotal: this.tokensCompactedTotal,
      tokensCachedTotal: this.tokensCachedTotal,
      tokensSavedTotal: tokensSaved,
      computeDollarsSavedTotal: Number(this.computeDollarsSavedTotal.toFixed(4)),
      compactionRatio: Number(compactionRatio.toFixed(4)),
      p50LatencyMs: Number(p50.toFixed(2)),
      p90LatencyMs: Number(p90.toFixed(2)),
      p99LatencyMs: Number(p99.toFixed(2)),
      turnsRecorded: count,
    };
  }

  /**
   * Generates standard Prometheus exposition format text
   */
  public toPrometheusMetrics(): string {
    const s = this.getSnapshot();
    const lines = [
      "# HELP skillprism_tokens_original_total Total uncompacted prompt tokens presented to tools",
      "# TYPE skillprism_tokens_original_total counter",
      `skillprism_tokens_original_total ${s.tokensOriginalTotal}`,
      "",
      "# HELP skillprism_tokens_compacted_total Total prompt tokens sent after JIT semantic pruning",
      "# TYPE skillprism_tokens_compacted_total counter",
      `skillprism_tokens_compacted_total ${s.tokensCompactedTotal}`,
      "",
      "# HELP skillprism_tokens_cached_total Total tokens served from native prompt cache",
      "# TYPE skillprism_tokens_cached_total counter",
      `skillprism_tokens_cached_total ${s.tokensCachedTotal}`,
      "",
      "# HELP skillprism_compute_dollars_saved_total Cumulative USD savings from prompt compaction",
      "# TYPE skillprism_compute_dollars_saved_total counter",
      `skillprism_compute_dollars_saved_total ${s.computeDollarsSavedTotal}`,
      "",
      "# HELP skillprism_compaction_ratio Ratio of compacted tokens saved (0.0 to 1.0)",
      "# TYPE skillprism_compaction_ratio gauge",
      `skillprism_compaction_ratio ${s.compactionRatio}`,
      "",
      "# HELP skillprism_latency_p99_ms P99 semantic routing and cache lookup latency in ms",
      "# TYPE skillprism_latency_p99_ms gauge",
      `skillprism_latency_p99_ms ${s.p99LatencyMs}`,
    ];

    return `${lines.join("\n")}\n`;
  }

  /**
   * Generates OpenTelemetry OTLP JSON export payload
   */
  public toOtlpJson(): Record<string, unknown> {
    const s = this.getSnapshot();
    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "skillprism-finops" } },
              { key: "deployment.environment", value: { stringValue: "production" } },
            ],
          },
          scopeMetrics: [
            {
              scope: { name: "skillprism.finops" },
              metrics: [
                {
                  name: "skillprism.tokens.saved",
                  unit: "tokens",
                  sum: { dataPoints: [{ asInt: s.tokensSavedTotal }] },
                },
                {
                  name: "skillprism.dollars.saved",
                  unit: "USD",
                  sum: { dataPoints: [{ asDouble: s.computeDollarsSavedTotal }] },
                },
                {
                  name: "skillprism.compaction.ratio",
                  unit: "1",
                  gauge: { dataPoints: [{ asDouble: s.compactionRatio }] },
                },
                {
                  name: "skillprism.latency.p99",
                  unit: "ms",
                  gauge: { dataPoints: [{ asDouble: s.p99LatencyMs }] },
                },
              ],
            },
          ],
        },
      ],
    };
  }
}
