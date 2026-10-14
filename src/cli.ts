import { BenchmarkEngine } from "./benchmark.js";
import { DevShelfSync } from "./devshelf-sync.js";
import { JitHarness } from "./harness.js";
import { SkillIndex } from "./index-store.js";
import { McpProtocolInterceptor } from "./interceptor.js";
import { SkillPrismProxyServer } from "./proxy-server.js";
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
    // Generate representative enterprise-scale catalog for reproducible benchmarking
    const fullBenchmarkCatalog: SkillDefinition[] = [...sampleSkills];
    const categories = ["database", "cloud", "devops", "api", "security", "analytics", "ai"];
    for (let i = 5; i <= 100; i++) {
      const cat = categories[i % categories.length] as any;
      fullBenchmarkCatalog.push({
        id: `tool_${i}`,
        name: `Enterprise Service Tool ${i}`,
        summary: `Performs automated enterprise operations on subsystem ${i} with strict validation and metrics`,
        description: `Enterprise grade tool ${i} connecting to corporate API endpoints with OAuth2 authentication and payload validation`,
        category: cat,
        tags: [cat, `service_${i}`, "enterprise", "integration"],
        permissions: [`${cat}:exec`],
        parameters: [
          { name: "targetId", type: "string", description: "Identifier of the target entity", required: true },
          { name: "options", type: "object", description: "Execution configuration payload" },
          { name: "dryRun", type: "boolean", description: "Simulate action without persisting changes" },
        ],
      });
    }

    const metrics = BenchmarkEngine.runComparison(fullBenchmarkCatalog);
    console.log(`📦 Catalog Size: ${metrics.catalogSize} Enterprise Tools`);
    console.log(`🔴 Unoptimized Preload Zero-State: ~${metrics.unoptimizedZeroStateTokens} tokens`);
    console.log(`🟢 SkillPrism JIT Zero-State:       ~${metrics.skillPrismZeroStateTokens} tokens`);
    console.log(`🚀 Upfront Token Savings:           ${metrics.tokenSavingsPercentage}%`);
    console.log(`⏱️ Average Search Latency:          ${metrics.searchLatencyMs} ms`);
    console.log(`💾 Payload Compaction Savings:      ${metrics.averageExecutionCompactionSavingsPercent}%\n`);
  } else if (command === "sync") {
    console.log("\n🌐 Ingesting Tools into Out-of-Context Index...\n");
    const res = await DevShelfSync.syncToCatalog(index);
    if (res.isFallback) {
      console.log(`ℹ️ [Offline Mode] Ingested ${res.totalSynced} seed community tools (live directory unavailable).`);
    } else {
      console.log(`✅ Successfully synced ${res.totalSynced} verified tools from DevShelf directory!`);
    }
    console.log("📊 Categories ingested:", res.categories);
  } else if (command === "proxy") {
    const harness = new JitHarness(index);
    const interceptor = new McpProtocolInterceptor(harness, index);
    const proxy = new SkillPrismProxyServer(interceptor);

    let port = 8080;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = Number.parseInt(args[portIdx + 1], 10) || 8080;
    }

    if (args.includes("--stdio")) {
      proxy.startStdio();
    } else {
      await proxy.startHttp({ port });
    }
  } else if (command === "stats") {
    const stats = index.getStats();
    console.log("\n📊 SkillPrism Index Telemetry:");
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`
📚 SkillPrism v1.1.1 — Progressive Skill Disclosure Engine

USAGE:
  skillprism search <intent>       Search out-of-context tool index by intent
  skillprism benchmark             Run comparative token savings & latency benchmark
  skillprism sync                  Ingest community tools into out-of-context index
  skillprism proxy [--port 8080]   Start transparent MCP proxy server (HTTP/SSE or --stdio)
  skillprism stats                 Inspect catalog token savings and metrics

EXAMPLES:
  $ npx @ritualdev-lab/skillprism search "upload file to s3"
  $ npx @ritualdev-lab/skillprism benchmark
  $ npx @ritualdev-lab/skillprism proxy --port 8080
  $ npx @ritualdev-lab/skillprism proxy --stdio
`);
  }
}

main().catch(console.error);
