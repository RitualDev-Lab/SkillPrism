import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTokenCompactionBenchmark } from "../benchmarks/token-compaction.js";
import { RedisSentinelRoutingClient, type RedisRemoteTransport } from "../src/redis-sentinel.js";

test("Phase 4: RedisSentinelRoutingClient seamlessly falls back to local disk-backed LRU when Redis is stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skillprism-p4-"));
  const fallbackFile = join(dir, "sentinel-fallback.json");

  try {
    let redisOnline = true;
    const remoteBacking = new Map<string, string>();
    const flakyTransport: RedisRemoteTransport = {
      async get(key) {
        if (!redisOnline) throw new Error("ECONNREFUSED: Redis Sentinel stopped");
        return remoteBacking.get(key) ?? null;
      },
      async set(key, value) {
        if (!redisOnline) throw new Error("ECONNREFUSED: Redis Sentinel stopped");
        remoteBacking.set(key, value);
      },
      async del(key) {
        if (!redisOnline) throw new Error("ECONNREFUSED: Redis Sentinel stopped");
        remoteBacking.delete(key);
      },
    };

    const client = new RedisSentinelRoutingClient({
      masterName: "skillprism-primary",
      sentinels: [
        { host: "10.0.1.1", port: 26379, zone: "az-1" },
        { host: "10.0.2.1", port: 26379, zone: "az-2" },
        { host: "10.0.3.1", port: 26379, zone: "az-3" },
      ],
      preferredZone: "az-2",
      localLruMaxEntries: 64,
      localFallbackDbPath: fallbackFile,
      remoteTransport: flakyTransport,
    });

    // 1. Healthy online write
    await client.set("receipt:r1", JSON.stringify({ rows: 50, status: "ok" }), 300);
    assert.equal(client.getStatus().mode, "redis-sentinel");
    assert.equal(client.isHealthy(), true);

    // 2. Simulate full Redis Sentinel outage (stopped)
    redisOnline = false;

    // Reading existing key succeeds with ZERO errors via local LRU fallback
    const cached = await client.get("receipt:r1");
    assert.ok(cached?.includes('"rows":50'));
    assert.equal(client.getStatus().sentinelReachable, false);
    assert.equal(client.getStatus().mode, "local-sqlite-lru");

    // Writing new keys during outage succeeds with ZERO errors and persists locally
    await client.set("receipt:r2", JSON.stringify({ rows: 120, offline: true }), 300);
    const offlineVal = await client.get("receipt:r2");
    assert.ok(offlineVal?.includes('"offline":true'));

    // 3. Restarting client against same fallback file recovers persisted offline receipts
    const restartedClient = new RedisSentinelRoutingClient({
      masterName: "skillprism-primary",
      sentinels: [{ host: "127.0.0.1", port: 26379 }],
      localFallbackDbPath: fallbackFile,
    });
    const recovered = await restartedClient.get("receipt:r2");
    assert.ok(recovered?.includes('"offline":true'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4: Reproducible token-compaction benchmark compares Raw vs OpenAI/Anthropic Caching vs SkillPrism JIT", async () => {
  const report = await runTokenCompactionBenchmark({
    catalogSize: 50,
    turnsPerSession: 5,
    costPerMillionTokens: 3.0,
  });

  assert.equal(report.rows.length, 5);
  const raw = report.rows[0];
  const openAiCache = report.rows[1];
  const anthropicCache = report.rows[2];
  const skillPrismJit = report.rows[3];
  const stacked = report.rows[4];

  assert.ok(
    raw.effectiveTokens > 10_000,
    "50-tool raw catalog over 5 turns must exceed 10k tokens",
  );
  assert.ok(openAiCache.effectiveTokens < raw.effectiveTokens);
  assert.ok(anthropicCache.effectiveTokens < openAiCache.effectiveTokens);
  assert.ok(skillPrismJit.effectiveTokens < anthropicCache.effectiveTokens);
  assert.ok(
    stacked.reductionVsRawPercent >= 90,
    `Expected >=90% stacked reduction, got ${stacked.reductionVsRawPercent}%`,
  );
});
