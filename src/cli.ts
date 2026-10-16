import { BenchmarkEngine } from "./benchmark.js";
import { DevShelfSync } from "./devshelf-sync.js";
import { JitHarness } from "./harness.js";
import { SkillIndex } from "./index-store.js";
import { McpProtocolInterceptor } from "./interceptor.js";
import { initProject } from "./init.js";
import { SkillPrismProxyServer } from "./proxy-server.js";
import type { SkillDefinition } from "./types.js";

const sampleSkills: SkillDefinition[] = [
  {
    id: "postgres_query",
    name: "PostgreSQL Query Exec",
    summary: "Executes parameterized read queries against production PostgreSQL clusters",
    description:
      "Performs read-only SQL queries with built-in connection pooling and PII redaction.",
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

  // Auto-hydrate persisted catalog from SQLite (~/.skillprism/index.sqlite) and local JSON
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { SkillPrismSqliteStore } = await import("./sqlite-store.js");
  const sqliteStore = new SkillPrismSqliteStore();

  if (sqliteStore.isAvailable()) {
    const sqliteSkills = sqliteStore.loadSkills();
    if (sqliteSkills.length > 0) {
      index.registerBatch(sqliteSkills);
      if (command !== "proxy") {
        console.log(`🗄️ Loaded ${sqliteSkills.length} tools from SQLite (${sqliteStore.getDbPath()})`);
      }
    }
  }

  const CATALOG_FILE = path.resolve(process.cwd(), ".skillprism.json");
  try {
    const rawSaved = await fs.readFile(CATALOG_FILE, "utf8");
    const count = index.importFromJson(rawSaved);
    if (count > 0 && command !== "proxy") {
      console.log(`📁 Loaded ${count} custom tools from .skillprism.json`);
    }
  } catch {
    // No existing catalog file
  }

  if (command === "init") {
    const isCursor = args.includes("--cursor") || (!args.includes("--claude") && !args.includes("--all"));
    const isClaude = args.includes("--claude") || args.includes("--all");
    const isAll = args.includes("--all");
    const isForce = args.includes("--force") || args.includes("--overwrite");

    console.log("\n⚡ Initializing SkillPrism in current project (safe non-destructive mode)...\n");

    const result = await initProject({
      cwd: process.cwd(),
      cursor: isCursor,
      claude: isClaude,
      all: isAll,
      force: isForce,
    });

    for (const backup of result.backupsCreated) {
      console.log(`📦 Created backup of existing configuration at ${backup}`);
    }

    for (const file of result.filesModified) {
      console.log(`✅ Safely updated ${file} (managed section preserved)`);
    }

    for (const warning of result.warnings) {
      console.warn(`⚠️ Warning: ${warning}`);
    }

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`❌ Error: ${err}`);
      }
      process.exit(1);
    }

    console.log("\n🎉 SkillPrism integration complete! Start your agent to enjoy 97%+ context savings.\n");
  } else if (command === "search") {
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
  } else if (command === "add") {
    const targetUrl = args[1];
    if (!targetUrl) {
      console.error("Usage: skillprism add <mcp-url-or-endpoint>");
      process.exit(1);
    }
    console.log(`\n🔌 Querying remote MCP endpoint: ${targetUrl}...`);
    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const data: any = await response.json();
      const tools = data?.result?.tools || [];
      if (!Array.isArray(tools) || tools.length === 0) {
        console.log("⚠️ No tools returned from endpoint or endpoint is not a JSON-RPC MCP server.");
      } else {
        const imported = index.importFromMcp(tools);
        await fs.writeFile(CATALOG_FILE, index.exportToJson(), "utf8");
        if (sqliteStore.isAvailable()) {
          sqliteStore.saveSkillsBatch(Array.from((index as any).skills.values()));
        }
        console.log(`✅ Successfully imported ${imported} tools and saved to SQLite & .skillprism.json!`);
      }
    } catch (err: any) {
      console.error(`❌ Failed to connect to MCP server: ${err.message}`);
    }
  } else if (command === "import") {
    const filePath = args[1];
    if (!filePath) {
      console.error("Usage: skillprism import <openapi-or-catalog.json>");
      process.exit(1);
    }
    try {
      const resolved = path.resolve(process.cwd(), filePath);
      const content = await fs.readFile(resolved, "utf8");
      const parsed = JSON.parse(content);

      let imported = 0;
      if (parsed.paths) {
        // OpenAPI specification
        imported = index.importFromOpenApi(parsed);
        console.log(`✅ Converted and indexed ${imported} endpoints from OpenAPI spec!`);
      } else {
        // SkillPrism or MCP catalog
        imported = index.importFromJson(content);
        console.log(`✅ Imported ${imported} tool definitions into catalog!`);
      }
      await fs.writeFile(CATALOG_FILE, index.exportToJson(), "utf8");
      if (sqliteStore.isAvailable()) {
        sqliteStore.saveSkillsBatch(Array.from((index as any).skills.values()));
      }
      console.log("💾 Saved updated catalog to SQLite and .skillprism.json");
    } catch (err: any) {
      console.error(`❌ Failed to import file: ${err.message}`);
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
          {
            name: "targetId",
            type: "string",
            description: "Identifier of the target entity",
            required: true,
          },
          { name: "options", type: "object", description: "Execution configuration payload" },
          {
            name: "dryRun",
            type: "boolean",
            description: "Simulate action without persisting changes",
          },
        ],
      });
    }

    const metrics = BenchmarkEngine.runComparison(fullBenchmarkCatalog);
    console.log(`📦 Catalog Size: ${metrics.catalogSize} Enterprise Tools`);
    console.log(`🔴 Unoptimized Preload Zero-State: ~${metrics.unoptimizedZeroStateTokens} tokens`);
    console.log(`🟢 SkillPrism JIT Zero-State:       ~${metrics.skillPrismZeroStateTokens} tokens`);
    console.log(`🚀 Upfront Token Savings:           ${metrics.tokenSavingsPercentage}%`);
    console.log(`⏱️ Average Search Latency:          ${metrics.searchLatencyMs} ms`);
    console.log(
      `💾 Payload Compaction Savings:      ${metrics.averageExecutionCompactionSavingsPercent}%\n`,
    );
  } else if (command === "sync") {
    console.log("\n🌐 Ingesting Tools into Out-of-Context Index...\n");
    const res = await DevShelfSync.syncToCatalog(index);
    if (res.isFallback) {
      console.log(
        `ℹ️ [Offline Mode] Ingested ${res.totalSynced} seed community tools (live directory unavailable).`,
      );
    } else {
      console.log(
        `✅ Successfully synced ${res.totalSynced} verified tools from DevShelf directory!`,
      );
    }
    console.log("📊 Categories ingested:", res.categories);
    await fs.writeFile(CATALOG_FILE, index.exportToJson(), "utf8");
    console.log("💾 Saved updated catalog to .skillprism.json");
  } else if (command === "proxy") {
    const isStdio = args.includes("--stdio");
    const isSimulate = args.includes("--dry-run-simulation") || args.includes("--simulate");
    const noTurnAdvance = args.includes("--no-turn-advance");

    let turnTtl = 3;
    const turnTtlIdx = args.indexOf("--turn-ttl");
    if (turnTtlIdx !== -1 && args[turnTtlIdx + 1]) {
      turnTtl = Number.parseInt(args[turnTtlIdx + 1], 10) || 3;
    }

    let idleTtlMs = 1000 * 60 * 10; // 10 minutes default
    const idleTtlIdx = args.indexOf("--idle-ttl");
    if (idleTtlIdx !== -1 && args[idleTtlIdx + 1]) {
      const seconds = Number.parseInt(args[idleTtlIdx + 1], 10) || 600;
      idleTtlMs = seconds * 1000;
    }

    const harness = new JitHarness(index, turnTtl, idleTtlMs);
    const interceptor = new McpProtocolInterceptor(harness, index);
    interceptor.setSimulationMode(isSimulate);
    if (noTurnAdvance) {
      interceptor.setAutoStepTurns(false);
    }

    // Initialize Upstream MCP Manager
    const { UpstreamManager } = await import("./upstream.js");
    const upstreamManager = new UpstreamManager();

    let configPath: string | undefined;
    const configIdx = args.indexOf("--config");
    if (configIdx !== -1 && args[configIdx + 1]) {
      configPath = path.resolve(process.cwd(), args[configIdx + 1]);
    }

    try {
      const connectedCount = await upstreamManager.loadFromMcpConfig(configPath, index);
      interceptor.setUpstreamManager(upstreamManager);
      if (connectedCount > 0 && !isStdio) {
        console.log(`🔌 Connected to ${connectedCount} upstream MCP servers from configuration`);
      }
    } catch (err: any) {
      if (!isStdio) {
        console.warn(`⚠️ Warning: Failed to connect upstream servers: ${err.message}`);
      }
    }

    const cleanup = async () => {
      await upstreamManager.closeAll();
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    const proxy = new SkillPrismProxyServer(interceptor);

    let port = 8080;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = Number.parseInt(args[portIdx + 1], 10) || 8080;
    }

    if (isStdio) {
      proxy.startStdio();
    } else {
      if (isSimulate) {
        console.log("🧪 Running in simulation mode (--dry-run-simulation enabled)");
      }
      await proxy.startHttp({ port });
    }
  } else if (command === "stats") {
    const stats = index.getStats();
    console.log("\n📊 SkillPrism Index Telemetry:");
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`
📚 SkillPrism v1.2.3 — Progressive Skill Disclosure Engine

USAGE:
  skillprism init [--cursor|--claude|--all] Non-destructive config initializer (.mcp.json, CLAUDE.md)
  skillprism search <intent>               Search out-of-context tool index by intent
  skillprism add <mcp-endpoint>            Fetch & register tools from remote MCP server
  skillprism import <openapi.json>         Convert OpenAPI 3.0 or JSON catalog into tools
  skillprism benchmark                     Run comparative token savings & latency benchmark
  skillprism sync                          Ingest community tools into out-of-context index
  skillprism proxy [--stdio|--port 8080]   Start transparent MCP proxy (forwards to real upstream tools)
                   [--turn-ttl <N>]        Turns before inactive tools expire (default: 3)
                   [--idle-ttl <seconds>]  Seconds before inactive tools expire (default: 600)
                   [--no-turn-advance]     Disable automatic turn advancement on tool execution
                   [--dry-run-simulation]  Opt into simulated execution for local mock testing
                   [--config <file>]       Path to custom MCP servers config (default: .mcp.json)
  skillprism stats                         Inspect catalog token savings and metrics

EXAMPLES:
  $ npx @ritualdev-lab/skillprism init --cursor
  $ npx @ritualdev-lab/skillprism search "upload file to s3"
  $ npx @ritualdev-lab/skillprism proxy --stdio --turn-ttl 5
  $ npx @ritualdev-lab/skillprism proxy --port 8080 --dry-run-simulation
`);
  }
}

main().catch(console.error);
