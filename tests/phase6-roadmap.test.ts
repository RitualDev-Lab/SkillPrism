import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  ContextCompactor,
  DevShelfSync,
  FastTextEmbeddingEngine,
  JitHarness,
  McpProtocolInterceptor,
  PluggableEmbeddingEngine,
  SkillIndex,
  SkillPrismSqliteStore,
  SqliteVecIndexAdapter,
  TransformerEmbeddingEngine,
} from "../src/index.js";

describe("Phase 6 Roadmap Suite: Embeddings, MCP Prompts/Resources, Compaction, DevShelf Sync & Vector Store", () => {
  describe("1. Pluggable Local Transformer Embeddings (ONNX / MiniLM)", () => {
    test("FastText embedding generates 64-dim unit vector and calculates cosine similarity", () => {
      const vec1 = FastTextEmbeddingEngine.embed("store photo in aws s3 bucket");
      const vec2 = FastTextEmbeddingEngine.embed("s3 upload image object");
      const vec3 = FastTextEmbeddingEngine.embed("kubernetes pod deployment restart");

      assert.equal(vec1.length, 64);
      assert.equal(vec2.length, 64);
      const simRelated = FastTextEmbeddingEngine.cosineSimilarity(vec1, vec2);
      const simUnrelated = FastTextEmbeddingEngine.cosineSimilarity(vec1, vec3);

      assert.ok(simRelated > simUnrelated);
      assert.ok(simRelated > 0.3);
    });

    test("PluggableEmbeddingEngine supports switching backends and gracefully handles missing transformer runtime", async () => {
      PluggableEmbeddingEngine.setBackend("fasttext");
      assert.equal(PluggableEmbeddingEngine.getBackend(), "fasttext");

      const syncVec = PluggableEmbeddingEngine.embedSync("test vector embedding");
      assert.equal(syncVec.length, 64);

      const asyncVec = await PluggableEmbeddingEngine.embed("test query", "transformers");
      assert.ok(Array.isArray(asyncVec));
      assert.ok(asyncVec.length > 0);

      // Verify availability check is a boolean
      const isAvailable = await TransformerEmbeddingEngine.isAvailable();
      assert.equal(typeof isAvailable, "boolean");
    });
  });

  describe("2. MCP Prompts & Resources Progressive Indexing", () => {
    test("SkillIndex registers, retrieves, and lists MCP Prompts and Resources", () => {
      const index = new SkillIndex();

      index.registerPrompt({
        name: "code_review",
        description: "Comprehensive code review prompt template",
        arguments: [{ name: "diff", description: "Git diff to review", required: true }],
      });

      index.registerResource({
        uri: "file:///workspace/schema.sql",
        name: "Database DDL Schema",
        description: "Postgres table DDL definitions",
        mimeType: "text/x-sql",
        text: "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);",
      });

      assert.equal(index.listPrompts().length, 1);
      assert.equal(index.getPrompt("code_review")?.name, "code_review");

      assert.equal(index.listResources().length, 1);
      assert.equal(index.getResource("file:///workspace/schema.sql")?.mimeType, "text/x-sql");
    });

    test("McpProtocolInterceptor advertises prompts & resources capabilities and handles protocol methods", async () => {
      const index = new SkillIndex();
      index.registerPrompt({
        name: "summarize_pr",
        description: "Generates release notes summary from PR description",
        handler: async (args) => ({
          messages: [{ role: "user", content: { type: "text", text: `Summarize: PR-${args.pr_id || "1"}` } }],
        }),
      });

      index.registerResource({
        uri: "file:///logs/agent.log",
        name: "Agent Execution Log",
        mimeType: "text/plain",
        text: "2026-11-01 [INFO] Agent started",
      });

      const harness = new JitHarness(index);
      const interceptor = new McpProtocolInterceptor(harness, index);

      // Initialize handshake advertises tools, prompts, resources capabilities
      const initRes = await interceptor.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      assert.equal(initRes.result.capabilities.tools.listChanged, true);
      assert.equal(initRes.result.capabilities.prompts.listChanged, true);
      assert.equal(initRes.result.capabilities.resources.listChanged, true);

      // prompts/list
      const promptsRes = await interceptor.handleMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "prompts/list",
      });
      assert.equal(promptsRes.result.prompts.length, 1);
      assert.equal(promptsRes.result.prompts[0].name, "summarize_pr");

      // prompts/get
      const promptGetRes = await interceptor.handleMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "prompts/get",
        params: { name: "summarize_pr", arguments: { pr_id: "123" } },
      });
      assert.equal(promptGetRes.result.messages.length, 1);
      assert.ok(promptGetRes.result.messages[0].content.text.includes("PR-123"));

      // resources/list
      const resourcesRes = await interceptor.handleMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/list",
      });
      assert.equal(resourcesRes.result.resources.length, 1);
      assert.equal(resourcesRes.result.resources[0].uri, "file:///logs/agent.log");

      // resources/read
      const resourceReadRes = await interceptor.handleMessage({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "file:///logs/agent.log" },
      });
      assert.equal(resourceReadRes.result.contents[0].text, "2026-11-01 [INFO] Agent started");

      // notification emitters
      let notifiedMethod = "";
      interceptor.onNotification((n) => {
        notifiedMethod = n.method;
      });

      interceptor.notifyPromptsListChanged();
      assert.equal(notifiedMethod, "notifications/prompts/list_changed");

      interceptor.notifyResourcesListChanged();
      assert.equal(notifiedMethod, "notifications/resources/list_changed");
    });
  });

  describe("3. Automated Return Payload Compaction & Receipts in SQLite LRU Cache", () => {
    test("automatically compacts large JSON payloads (e.g. 500 DB rows) and persists to SQLite LRU cache", () => {
      const sqliteStore = new SkillPrismSqliteStore(":memory:");
      assert.ok(sqliteStore.isAvailable());

      const compactor = new ContextCompactor(256, 60000, 100, undefined, sqliteStore);

      // Simulate a tool returning 500 database rows
      const dbRows = Array.from({ length: 500 }, (_, i) => ({
        id: i + 1,
        username: `user_${i + 1}`,
        email: `user_${i + 1}@company.internal`,
        role: i % 10 === 0 ? "admin" : "member",
        active: true,
        lastLogin: "2026-11-01T12:00:00Z",
      }));

      const res = compactor.compact("query_users", dbRows);
      assert.equal(res.isCompacted, true);
      assert.ok(res.receipt);
      assert.ok(res.receipt.ref.startsWith("receipt:query_users:"));
      assert.equal(res.receipt.keyFields.count, 500);
      assert.ok(res.receipt.tokensSaved > 1000);

      // Verify the full payload was stored in SQLite
      const loadedFromSqlite = sqliteStore.loadReceiptData(res.receipt.ref);
      assert.ok(Array.isArray(loadedFromSqlite));
      assert.equal(loadedFromSqlite.length, 500);

      // Test fallback retrieval via inspectReceipt when in-memory vault entry is purged
      (compactor as any).vault.clear();
      const inspectRes = compactor.inspectReceipt(res.receipt.ref, "count");
      assert.equal(inspectRes.success, true);
      assert.equal(inspectRes.data, 500);

      sqliteStore.close();
    });
  });

  describe("4. DevShelf Live Catalog Auto-Sync with ETag & Category Skills", () => {
    test("DevShelfSync handles ETag caching and registers category umbrella skills", async () => {
      DevShelfSync.clearCache();
      const index = new SkillIndex();

      const mockCatalog = [
        {
          name: "PostgreSQL Client",
          url: "https://postgres.org",
          description: "Relational SQL database client",
          category: "database",
          tags: ["sql", "rdbms"],
        },
        {
          name: "AWS DynamoDB",
          url: "https://aws.amazon.com/dynamodb",
          description: "NoSQL document database service",
          category: "database",
          tags: ["nosql", "cloud"],
        },
        {
          name: "Snyk",
          url: "https://snyk.io",
          description: "Developer security scanner",
          category: "security",
          tags: ["vulnerabilities", "audit"],
        },
      ];

      // First sync returns items and registers category skills
      const res1 = await DevShelfSync.syncToCatalog(index, async (url, init) => {
        return mockCatalog;
      });

      assert.equal(res1.totalSynced, 3);
      assert.equal(res1.categorySkillsCreated, 2); // database and security
      assert.ok(index.get("devshelf_category_database"));
      assert.ok(index.get("devshelf_category_security"));

      const catSkill = index.get("devshelf_category_database");
      assert.ok(catSkill?.summary.includes("database developer tools"));

      // Second sync with 304 simulation
      DevShelfSync.setLastEtag('"etag-12345"');
      const res2 = await DevShelfSync.syncToCatalog(index, async (url, init) => {
        return { status: 304 };
      });

      assert.equal(res2.isCached304, true);
      assert.equal(res2.totalSynced, 3);
    });
  });

  describe("5. Persistent Vector Index Storage (SQLite-vec Adapter)", () => {
    test("SqliteVecIndexAdapter stores and queries dense vectors with nearest neighbor search", () => {
      const store = new SkillPrismSqliteStore(":memory:");
      const adapter = new SqliteVecIndexAdapter(store);
      assert.ok(adapter.isAvailable());

      const v1 = [1.0, 0.0, 0.0];
      const v2 = [0.9, 0.1, 0.0];
      const v3 = [0.0, 0.0, 1.0];

      adapter.saveVector("tool_a", v1);
      adapter.saveVector("tool_b", v2);
      adapter.saveVector("tool_c", v3);

      const allVectors = adapter.loadVectors();
      assert.equal(allVectors.size, 3);
      assert.deepEqual(allVectors.get("tool_a"), v1);

      // Search nearest to [1, 0, 0]
      const nearest = adapter.searchNearest([1.0, 0.0, 0.0], 2);
      assert.equal(nearest.length, 2);
      assert.equal(nearest[0].id, "tool_a");
      assert.equal(nearest[0].similarity, 1.0);
      assert.equal(nearest[1].id, "tool_b");

      store.close();
    });

    test("SkillIndex auto-syncs and warm-loads skills and vectors across restarts", () => {
      const store = new SkillPrismSqliteStore(":memory:");
      const adapter = new SqliteVecIndexAdapter(store);

      // Session 1: Register tools with persistent store attached
      const session1Index = new SkillIndex();
      session1Index.attachPersistentStore(adapter);

      session1Index.register({
        id: "aws_s3_upload",
        name: "AWS S3 Upload",
        summary: "Upload files and photos to Amazon S3 bucket",
        description: "Uploads binary objects and blobs to AWS S3 storage",
        category: "cloud",
        tags: ["s3", "storage", "upload", "photo"],
        parameters: [{ name: "key", type: "string", description: "S3 object key" }],
      });

      session1Index.register({
        id: "postgres_query",
        name: "PostgreSQL Query",
        summary: "Execute SQL queries on PostgreSQL database",
        description: "Executes SELECT, INSERT, UPDATE statements",
        category: "database",
        tags: ["sql", "database", "query"],
        parameters: [{ name: "sql", type: "string", description: "SQL statement" }],
      });

      // Verify persistent store received skills and vectors
      assert.equal(store.loadSkills().length, 2);
      assert.equal(adapter.loadVectors().size, 2);

      // Session 2: Fresh restart, warm-load directly from persistent store
      const session2Index = new SkillIndex();
      const loadedCount = session2Index.loadFromPersistentStore(adapter);
      assert.equal(loadedCount, 2);

      assert.ok(session2Index.get("aws_s3_upload"));
      assert.ok(session2Index.get("postgres_query"));

      // Verify search operates immediately on loaded skills and precomputed vectors
      const searchResults = session2Index.search("store photo in cloud s3");
      assert.ok(searchResults.length > 0);
      assert.equal(searchResults[0].skill.id, "aws_s3_upload");

      store.close();
    });
  });
});
