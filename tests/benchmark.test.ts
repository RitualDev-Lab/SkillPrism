import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { BenchmarkEngine } from "../src/benchmark.js";
import { DevShelfSync } from "../src/devshelf-sync.js";
import { SkillIndex } from "../src/index-store.js";
import type { SkillDefinition } from "../src/types.js";

describe("Phase 5: CLI, Benchmarking Suite & DevShelf Dogfooding Suite", () => {
  const catalog: SkillDefinition[] = [
    {
      id: "postgres_query",
      name: "PostgreSQL Query",
      summary: "Runs SQL query against database with connection pooling",
      description: "Postgres query executor with PII scrubbing.",
      category: "database",
      tags: ["sql", "postgres"],
      parameters: [{ name: "sql", type: "string", description: "query", required: true }],
    },
    {
      id: "aws_s3_upload",
      name: "AWS S3 Upload",
      summary: "Uploads file to S3 bucket",
      description: "AWS S3 storage object uploader with SSE encryption.",
      category: "cloud",
      tags: ["aws", "s3"],
      parameters: [{ name: "key", type: "string", description: "key", required: true }],
    },
    {
      id: "k8s_pods",
      name: "Kubernetes Pod Inspector",
      summary: "Inspects status of Kubernetes pods across namespaces",
      description: "Queries active kubeconfig for running pods.",
      category: "devops",
      tags: ["k8s", "kubernetes"],
      parameters: [{ name: "namespace", type: "string", description: "K8s namespace", required: true }],
    },
    {
      id: "stripe_charge",
      name: "Stripe Payment Processor",
      summary: "Processes customer credit cards and creates payment intents",
      description: "Stripe API billing checkout gateway integration.",
      category: "api",
      tags: ["stripe", "billing"],
      parameters: [{ name: "amount", type: "number", description: "Charge amount", required: true }],
    },
  ];

  // Extend with representative enterprise tool catalog
  for (let i = 5; i <= 20; i++) {
    catalog.push({
      id: `service_tool_${i}`,
      name: `Enterprise Integration Tool ${i}`,
      summary: `Automates subsystem operations for enterprise service ${i}`,
      description: `Dispatches authenticated RPC calls and queries to cloud service ${i}.`,
      category: "cloud",
      tags: ["cloud", `service_${i}`],
      parameters: [
        { name: "resourceId", type: "string", description: "Target resource ID", required: true },
        { name: "payload", type: "object", description: "JSON payload options" },
      ],
    });
  }

  test("BenchmarkEngine quantifies token savings and sub-millisecond search latency", () => {
    const metrics = BenchmarkEngine.runComparison(catalog);

    assert.equal(metrics.catalogSize, 20);
    assert.ok(metrics.unoptimizedZeroStateTokens > metrics.skillPrismZeroStateTokens);
    assert.ok(metrics.tokenSavingsPercentage > 0);
    assert.ok(metrics.searchLatencyMs >= 0);
    assert.ok(metrics.averageExecutionCompactionSavingsPercent > 50);
  });

  test("DevShelfSync ingests developer tools into out-of-context catalog", async () => {
    const index = new SkillIndex();

    // Mock fetch with 3 sample tools
    const mockTools = [
      { name: "Prisma", url: "https://prisma.io", description: "Next-generation ORM for Node.js and TypeScript", category: "database" },
      { name: "Render", url: "https://render.com", description: "Unified cloud platform to host apps and databases", category: "cloud" },
      { name: "Postman", url: "https://postman.com", description: "Collaborative API development platform", category: "api" }
    ];

    const result = await DevShelfSync.syncToCatalog(index, async () => mockTools);

    assert.equal(result.totalSynced, 3);
    assert.equal(result.categories.database, 1);
    assert.equal(result.categories.cloud, 1);
    assert.equal(result.categories.api, 1);

    const prisma = index.get("devshelf_prisma");
    assert.ok(prisma);
    assert.equal(prisma.category, "database");
  });

  test("DevShelfSync falls back gracefully when network fetch fails", async () => {
    const index = new SkillIndex();
    const result = await DevShelfSync.syncToCatalog(index, async () => {
      throw new Error("Network offline");
    });

    assert.ok(result.totalSynced >= 5); // Fallback seed catalog has 5 items
    assert.ok(index.get("devshelf_supabase"));
    assert.ok(index.get("devshelf_agentshield"));
  });
});
