import assert from "node:assert";
import test from "node:test";
import {
  PromptCacheStack,
  FinOpsMetricsExporter,
  RedisSentinelRoutingClient,
} from "../src/index.js";

test("PromptCacheStack - Prepares Anthropic ephemeral cache_control breakpoints & OpenAI prefix order", () => {
  const stack = new PromptCacheStack({
    provider: "anthropic",
    enableAnthropicCacheControl: true,
    enableOpenAiPrefixSorting: true,
  });

  const tools = [
    { name: "zebra_search", description: "Search zebra" },
    { name: "apple_fetch", description: "Fetch apple" },
    { name: "middle_query", description: "Query middle" },
  ];

  const prepared = stack.prepareToolsPayload(tools);

  // Assert sorted order for OpenAI prefix matching
  assert.strictEqual(prepared[0].name, "apple_fetch");
  assert.strictEqual(prepared[1].name, "middle_query");
  assert.strictEqual(prepared[2].name, "zebra_search");

  // Assert cache_control breakpoint placed on final tool
  assert.strictEqual(prepared[0].cache_control, undefined);
  assert.strictEqual(prepared[2].cache_control?.type, "ephemeral");
});

test("PromptCacheStack - Stacks semantic pruning with prompt caching to achieve 98%+ token reduction", () => {
  const stack = new PromptCacheStack({ provider: "anthropic" });

  // 500 MCP tools catalog = ~40,000 raw prompt tokens
  const rawTokens = 40_000;
  // SkillPrism JIT semantic pruning isolates top 3 relevant tools = ~250 tokens
  const prunedTokens = 250;
  // Native prompt cache hit ratio = 100% on subsequent turns
  const metrics = stack.calculateStackedSavings(rawTokens, prunedTokens, 1.0, 3.0);

  // 40,000 -> 250 with 90% cache discount = 25 effective tokens => 99.94% reduction
  assert.ok(metrics.reductionPercentage >= 98.0);
  assert.strictEqual(metrics.effectiveCachedTokens, 25);
  assert.ok(metrics.dollarsSaved > 0.11);
});

test("FinOpsMetricsExporter - Records turns and outputs valid Prometheus & OTLP formats", () => {
  const exporter = new FinOpsMetricsExporter();

  exporter.recordTurn({
    originalTokens: 40_000,
    compactedTokens: 250,
    cachedTokens: 225,
    latencyMs: 4.8,
    costPerMillion: 3.0,
  });

  exporter.recordTurn({
    originalTokens: 35_000,
    compactedTokens: 300,
    cachedTokens: 270,
    latencyMs: 6.2,
    costPerMillion: 3.0,
  });

  const snapshot = exporter.getSnapshot();
  assert.strictEqual(snapshot.turnsRecorded, 2);
  assert.strictEqual(snapshot.tokensOriginalTotal, 75_000);
  assert.strictEqual(snapshot.tokensCompactedTotal, 550);
  assert.ok(snapshot.compactionRatio >= 0.98);
  assert.ok(snapshot.computeDollarsSavedTotal > 0.20);
  assert.ok(snapshot.p99LatencyMs <= 10.0);

  // Verify Prometheus format
  const prom = exporter.toPrometheusMetrics();
  assert.ok(prom.includes("skillprism_tokens_original_total 75000"));
  assert.ok(prom.includes("skillprism_tokens_compacted_total 550"));
  assert.ok(prom.includes("skillprism_compaction_ratio"));

  // Verify OTLP format
  const otel = exporter.toOtlpJson() as any;
  assert.ok(otel.resourceMetrics[0].scopeMetrics[0].metrics.length >= 4);
});

test("RedisSentinelRoutingClient - Supports 3-AZ Sentinel clustering and failover handling", async () => {
  const client = new RedisSentinelRoutingClient({
    masterName: "mymaster",
    preferredZone: "az-2",
    sentinels: [
      { host: "redis-sentinel-1.vpc", port: 26379, zone: "az-1" },
      { host: "redis-sentinel-2.vpc", port: 26379, zone: "az-2" },
      { host: "redis-sentinel-3.vpc", port: 26379, zone: "az-3" },
    ],
  });

  assert.strictEqual(client.isHealthy(), true);
  const replica = client.getOptimalReadReplica();
  assert.strictEqual(replica.zone, "az-2");

  // Simulate failover
  client.handleFailover({ host: "redis-sentinel-3.vpc", port: 6379, zone: "az-3" });
  assert.strictEqual(client.getMaster().zone, "az-3");

  // In-memory fallback
  await client.set("key_42", "receipt_payload");
  assert.strictEqual(await client.get("key_42"), "receipt_payload");
  await client.del("key_42");
  assert.strictEqual(await client.get("key_42"), null);
});
