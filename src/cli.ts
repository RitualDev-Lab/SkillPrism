#!/usr/bin/env node
import { BenchmarkEngine } from "./benchmark.js";
import { DevShelfSync } from "./devshelf-sync.js";
import { SkillIndex } from "./index-store.js";
import type { SkillDefinition } from "./types.js";

const sampleSkills: SkillDefinition[] = [
  {
    id: "postgres_query",
    name: "PostgreSQL Query Exec",
    summary: "Executes parameterized read queries against production PostgreSQL clusters",
    description: "Performs read-only SQL queries with built-in connection pooling and PII redaction.",
    category: "database",
    tags: ["sql", "postgres", "db", "database", "query"],
    permissions: ["db:read"],
    parameters: [
      { name: "sql", type: "string", description: "The SQL statement", required: true },
      { name: "params", type: "array", description: "Query bind variables" },
    ],
  },
  {
    id: "aws_s3_upload",
    name: "AWS S3 File Upload",
    summary: "Uploads binary files and objects directly to S3 buckets",
    description: "Streams local files or raw buffers to Amazon S3 with SSE-S3 encryption.",
    category: "cloud",
    tags: ["aws", "s3", "storage", "cloud", "upload", "bucket"],
    permissions: ["s3:put"],
    parameters: [
      { name: "bucket", type: "string", description: "Target S3 bucket name", required: true },
      { name: "key", type: "string", description: "Object destination key", required: true },
      { name: "filePath", type: "string", description: "Source local file path", required: true },
    ],
  },
  {
    id: "kubernetes_inspect_pods",
    name: "Kubernetes Pods Inspector",
    summary: "Lists running pods, status, and restarts across Kubernetes namespaces",
    description: "Connects to active kubeconfig and returns pods with health status.",
    category: "devops",
    tags: ["k8s", "kubernetes", "devops", "pods", "containers"],
    permissions: ["k8s:read"],
    parameters: [
      { name: "namespace", type: "string", description: "K8s namespace (default: default)" },
      { name: "limit", type: "number", description: "Max pods to return" },
    ],
  },
  {
    id: "stripe_charge_customer",
    name: "Stripe Payment Processor",
    summary: "Creates payment intents and charges customers via Stripe API",
    description: "Generates idempotent payment intents and processes customer credit cards.",
    category: "api",
    tags: ["stripe", "payment", "billing", "credit-card", "charge"],
    permissions: ["stripe:write"],
    parameters: [
      { name: "amount", type: "number", description: "Amount in cents", required: true },
      { name: "currency", type: "string", description: "3-letter currency code", required: true },
      { name: "customerId", type: "string", description: "Stripe customer ID", required: true },
    ],
  },
];

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  const index = new SkillIndex();
  index.registerBatch(sampleSkills);

  if (command === "search") {
    const query = args.slice(1).join(" ");
    if (!query) {
      console.error("Usage: skillprism search <query>");
      process.exit(1);
    }
    console.log(`\n🔍 Searching Out-of-Context Catalog for: "${query}"...\n`);
    const results = index.search(query, 3);
    for (const r of results) {
      console.log(`✨ [Score: ${r.score}] ${r.skill.name} (${r.skill.id})`);
      console.log(`   Summary: ${r.skill.summary}`);
      console.log(`   Tokens: ~${r.skill.tokenCostEstimate} tokens saved from zero-state\n`);
    }
  } else if (command === "benchmark") {
    console.log("\n⚡ Running SkillPrism Token Optimization & Latency Benchmark...\n");
    const metrics = BenchmarkEngine.runComparison(sampleSkills);
    console.log(`📦 Catalog Size: ${metrics.catalogSize} tools`);
    console.log(`🔴 Unoptimized Preload Zero-State: ~${metrics.unoptimizedZeroStateTokens} tokens`);
    console.log(`🟢 SkillPrism JIT Zero-State:       ~${metrics.skillPrismZeroStateTokens} tokens`);
    console.log(`🚀 Upfront Token Savings:           ${metrics.tokenSavingsPercentage}%`);
    console.log(`⏱️ Average Search Latency:          ${metrics.searchLatencyMs} ms`);
    console.log(`💾 Payload Compaction Savings:      ${metrics.averageExecutionCompactionSavingsPercent}%\n`);
  } else if (command === "sync") {
    console.log("\n🌐 Syncing 520+ DevShelf Catalog Tools into Out-of-Context Index...\n");
    const res = await DevShelfSync.syncToCatalog(index);
    console.log(`✅ Successfully synced ${res.totalSynced} tools from DevShelf directory!`);
    console.log("📊 Categories ingested:", res.categories);
  } else if (command === "stats") {
    const stats = index.getStats();
    console.log("\n📊 SkillPrism Index Telemetry:");
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`
📚 SkillPrism v0.1.0 — Progressive Skill Disclosure Engine

USAGE:
  skillprism search <intent>    Search out-of-context tool index by intent
  skillprism benchmark          Run comparative token savings & latency benchmark
  skillprism sync               Ingest 520+ tools from DevShelf public directory
  skillprism stats              Inspect catalog token savings and metrics

EXAMPLES:
  $ npx @ritualdev-lab/skillprism search "upload file to s3"
  $ npx @ritualdev-lab/skillprism benchmark
  $ npx @ritualdev-lab/skillprism sync
`);
  }
}

main().catch(console.error);
