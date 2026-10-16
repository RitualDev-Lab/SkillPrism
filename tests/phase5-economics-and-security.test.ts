import assert from "node:assert/strict";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import test from "node:test";
import { BenchmarkEngine } from "../src/benchmark.js";
import { JitHarness } from "../src/harness.js";
import { SkillIndex } from "../src/index-store.js";
import { McpProtocolInterceptor, toMcpInputSchema } from "../src/interceptor.js";
import { SkillPrismProxyServer } from "../src/proxy-server.js";
import type { SkillDefinition } from "../src/types.js";
import { UpstreamManager } from "../src/upstream.js";

test("Phase 5: Deep Schema Preservation (Enums, $defs, oneOf, additionalProperties)", () => {
  // 1. Raw MCP / JSON Schema with advanced schema constraints
  const complexSchema = {
    type: "object",
    additionalProperties: false,
    $defs: {
      ClusterTier: {
        type: "string",
        enum: ["standard", "pro", "enterprise"],
      },
    },
    properties: {
      environment: {
        type: "string",
        enum: ["development", "staging", "production"],
        description: "Target deployment environment",
      },
      tier: {
        $ref: "#/$defs/ClusterTier",
      },
      replicas: {
        type: "number",
        default: 3,
      },
      networkConfig: {
        type: "object",
        additionalProperties: true,
        properties: {
          vpcId: { type: "string" },
        },
      },
      credentials: {
        oneOf: [
          { type: "string", description: "API Key" },
          {
            type: "object",
            properties: {
              clientId: { type: "string" },
              clientSecret: { type: "string" },
            },
            required: ["clientId", "clientSecret"],
          },
        ],
      },
    },
    required: ["environment"],
  };

  const normalized = toMcpInputSchema(complexSchema);

  // Assert top-level keywords preserved
  assert.equal(normalized.type, "object");
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(normalized.$defs, complexSchema.$defs);
  assert.deepEqual(normalized.required, ["environment"]);

  // Assert property-level constraints preserved
  assert.deepEqual(normalized.properties.environment.enum, [
    "development",
    "staging",
    "production",
  ]);
  assert.equal(normalized.properties.tier.$ref, "#/$defs/ClusterTier");
  assert.ok(normalized.properties.credentials.oneOf);
  assert.equal(normalized.properties.credentials.oneOf.length, 2);

  // 2. Verify Harness convertToToolDefinition preserves full schema
  const skill: SkillDefinition = {
    id: "deploy_service",
    name: "Deploy Service",
    summary: "Deploys an infrastructure service cluster",
    description: "Detailed service cluster deployment specification",
    category: "cloud",
    tags: ["cloud", "deploy"],
    parameters: [],
    rawSchema: complexSchema,
  };

  const index = new SkillIndex();
  index.register(skill);
  const harness = new JitHarness(index);

  const toolDef = harness.convertToToolDefinition(skill);
  assert.equal(toolDef.name, "deploy_service");
  assert.equal(toolDef.parameters.additionalProperties, false);
  assert.deepEqual(toolDef.parameters.$defs, complexSchema.$defs);
  assert.deepEqual(toolDef.parameters.properties.environment.enum, [
    "development",
    "staging",
    "production",
  ]);

  // 3. Verify SkillParameter[] array format preserves enums and defaults
  const paramListSkill: SkillDefinition = {
    id: "database_action",
    name: "Database Action",
    summary: "Performs database maintenance",
    description: "Maintenance command",
    category: "database",
    tags: ["database"],
    parameters: [
      {
        name: "action",
        type: "string",
        description: "Operation type",
        required: true,
        enum: ["vacuum", "reindex", "analyze"],
      },
      {
        name: "timeoutSeconds",
        type: "number",
        description: "Timeout duration",
        default: 30,
      },
    ],
  };

  const paramToolDef = harness.convertToToolDefinition(paramListSkill);
  assert.deepEqual(paramToolDef.parameters.properties.action.enum, [
    "vacuum",
    "reindex",
    "analyze",
  ]);
  assert.equal(paramToolDef.parameters.properties.timeoutSeconds.default, 30);
});

test("Phase 5: HTTP Bearer Authentication & Origin Controls", async () => {
  const index = new SkillIndex();
  const harness = new JitHarness(index);
  const interceptor = new McpProtocolInterceptor(harness, index);
  interceptor.setSimulationMode(true);
  const proxy = new SkillPrismProxyServer(interceptor);

  const AUTH_TOKEN = "skillprism-secret-token-12345";
  const ALLOWED_ORIGIN = "https://agent-app.internal";

  await proxy.startHttp({
    port: 0,
    authToken: AUTH_TOKEN,
    allowedOrigins: [ALLOWED_ORIGIN],
  });

  const addr = proxy.getAddress();
  assert.ok(addr);
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Health check endpoint is accessible unauthenticated
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.security.authConfigured, true);

    // 2. Request without Authorization header is rejected with 401
    const unauthRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauthRes.status, 401);
    const unauthBody = await unauthRes.json();
    assert.equal(unauthBody.error, "Unauthorized");

    // 3. Request with invalid token is rejected with 401
    const badTokenRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(badTokenRes.status, 401);

    // 4. Request with valid token succeeds with 200
    const validRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.ok(Array.isArray(validBody.result.tools));

    // 5. Untrusted origin is rejected with 403 Forbidden
    const forbiddenOriginRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Origin: "https://evil-untrusted-site.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    assert.equal(forbiddenOriginRes.status, 403);

    // 6. Allowed origin receives 200 and Access-Control-Allow-Origin header
    const allowedOriginRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    });
    assert.equal(allowedOriginRes.status, 200);
    assert.equal(
      allowedOriginRes.headers.get("access-control-allow-origin"),
      ALLOWED_ORIGIN,
    );
  } finally {
    await proxy.close();
  }
});

test("Phase 5: Request Payload Size Limiting (413 Payload Too Large)", async () => {
  const index = new SkillIndex();
  const harness = new JitHarness(index);
  const interceptor = new McpProtocolInterceptor(harness, index);
  const proxy = new SkillPrismProxyServer(interceptor);

  // Set maximum body limit to 512 bytes
  await proxy.startHttp({
    port: 0,
    maxBodySizeBytes: 512,
  });

  const addr = proxy.getAddress();
  assert.ok(addr);
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Normal small payload succeeds
    const smallRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(smallRes.status, 200);

    // 2. Large payload exceeding 512 bytes is rejected with 413
    const oversizedBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "test",
        arguments: {
          bloat: "A".repeat(2048),
        },
      },
    });

    const largeRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });
    assert.equal(largeRes.status, 413);
    const errJson = await largeRes.json();
    assert.equal(errJson.error, "Payload Too Large");
  } finally {
    await proxy.close();
  }
});

test("Phase 5: Multi-Tenant Session Isolation (mcp-session-id)", async () => {
  const index = new SkillIndex();
  index.register({
    id: "stripe_charge",
    name: "Stripe Charge",
    summary: "Creates a Stripe payment charge",
    description: "Credit card billing execution",
    category: "api",
    tags: ["payment", "stripe"],
    parameters: [
      { name: "amount", type: "number", description: "Amount in cents", required: true },
    ],
  });

  const harness = new JitHarness(index, 3);
  const interceptor = new McpProtocolInterceptor(harness, index);
  interceptor.setSimulationMode(true);
  const proxy = new SkillPrismProxyServer(interceptor);

  await proxy.startHttp({
    port: 0,
    enableSessionIsolation: true,
  });

  const addr = proxy.getAddress();
  assert.ok(addr);
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Session Alpha activates stripe_charge
    const loadAlphaRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "session-alpha",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "load_skill",
          arguments: { skill_id: "stripe_charge" },
        },
      }),
    });
    assert.equal(loadAlphaRes.status, 200);

    // Session Alpha lists tools -> stripe_charge is present
    const listAlphaRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "session-alpha",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listAlphaJson = await listAlphaRes.json();
    const alphaTools = listAlphaJson.result.tools.map((t: any) => t.name);
    assert.ok(alphaTools.includes("stripe_charge"));

    // Session Beta lists tools -> stripe_charge is NOT present (Zero-leak session isolation!)
    const listBetaRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "session-beta",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    const listBetaJson = await listBetaRes.json();
    const betaTools = listBetaJson.result.tools.map((t: any) => t.name);
    assert.ok(!betaTools.includes("stripe_charge"));
    assert.equal(betaTools.length, 3); // Only 3 meta-tools

    // Session Beta attempting to call stripe_charge is blocked by JIT Gate
    const callBetaRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "session-beta",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "stripe_charge",
          arguments: { amount: 5000 },
        },
      }),
    });
    const callBetaJson = await callBetaRes.json();
    assert.equal(callBetaJson.error.code, -32002); // JIT Gate Block

    // Session Alpha CAN call stripe_charge
    const callAlphaRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "session-alpha",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "stripe_charge",
          arguments: { amount: 5000 },
        },
      }),
    });
    const callAlphaJson = await callAlphaRes.json();
    assert.ok(callAlphaJson.result);

    assert.equal(proxy.getSessionCount(), 2);
  } finally {
    await proxy.close();
  }
});

test("Phase 5: Complete-Task Multi-Turn Trajectory Economics Benchmark & 100% Task Success Rate", async () => {
  const catalog: SkillDefinition[] = [
    {
      id: "postgres_query",
      name: "PostgreSQL Query Executor",
      summary: "Execute parameterized SQL queries on PostgreSQL databases",
      description: "Direct connection pool query execution with SSL support",
      category: "database",
      tags: ["postgres", "database", "sql", "query"],
      parameters: [
        { name: "sql", type: "string", description: "SQL query statement", required: true },
        { name: "params", type: "array", description: "Query bind parameters" },
      ],
    },
    {
      id: "s3_upload",
      name: "AWS S3 File Upload",
      summary: "Upload objects to Amazon S3 buckets",
      description: "Multipart bucket storage upload with SSE-KMS",
      category: "cloud",
      tags: ["s3", "storage", "cloud", "aws"],
      parameters: [
        { name: "bucket", type: "string", description: "S3 Bucket Name", required: true },
        { name: "key", type: "string", description: "Target object key", required: true },
      ],
    },
    {
      id: "k8s_deploy",
      name: "Kubernetes Cluster Deployment",
      summary: "Deploy pods, services, and ingresses on Kubernetes",
      description: "Orchestration manager for cloud clusters",
      category: "devops",
      tags: ["kubernetes", "k8s", "deploy"],
      parameters: [
        { name: "manifest", type: "string", description: "YAML manifest", required: true },
      ],
    },
  ];

  // Add 40 additional realistic tools to simulate real enterprise MCP catalog
  for (let i = 0; i < 40; i++) {
    catalog.push({
      id: `enterprise_tool_${i}`,
      name: `Enterprise Tool Service ${i}`,
      summary: `Automated enterprise automation utility ${i}`,
      description: "Production enterprise utility with authentication, retry logic, and monitoring.",
      category: "general",
      tags: ["enterprise", `tool_${i}`],
      parameters: [
        { name: "id", type: "string", description: "Resource id", required: true },
        { name: "options", type: "object", description: "Config payload" },
        { name: "dryRun", type: "boolean", description: "Dry run" },
      ],
    });
  }

  const trajectory = await BenchmarkEngine.runTrajectoryBenchmark(catalog, {
    totalTurns: 5,
    searchQuery: "postgres database sql query",
    targetToolId: "postgres_query",
    resultRowCount: 45,
  });

  // Verify task success rate
  assert.equal(trajectory.taskSuccessRate, 1.0); // 100% task success rate

  // Verify token accounting
  assert.equal(trajectory.catalogSize, 43);
  assert.equal(trajectory.totalTurns, 5);
  assert.ok(trajectory.monolithicTotalTokens > 10000);
  assert.ok(trajectory.skillPrismTotalTokens < 4000);

  // Net trajectory savings across search, load, heavy output compaction, and inspection
  assert.ok(
    trajectory.netTokenSavingsPercent > 70.0,
    `Expected >70% net savings, got ${trajectory.netTokenSavingsPercent}%`,
  );
  assert.ok(
    trajectory.tokenEfficiencyMultiplier >= 3.5,
    `Expected >= 3.5x multiplier, got ${trajectory.tokenEfficiencyMultiplier}x`,
  );
});

test("Phase 5: Full End-to-End Workflow with Upstream Server, Auth, Search, Load, Compact & Expiration", async () => {
  // 1. Setup real Upstream HTTP MCP Server
  const upstreamServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);

      if (parsed.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              tools: [
                {
                  name: "cloud_deploy_cluster",
                  description: "Deploy distributed cluster nodes with automated scaling",
                  inputSchema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      clusterName: { type: "string" },
                      nodeCount: { type: "number", default: 5 },
                      region: {
                        type: "string",
                        enum: ["us-east-1", "eu-central-1", "ap-southeast-1"],
                      },
                    },
                    required: ["clusterName"],
                  },
                },
              ],
            },
          }),
        );
        return;
      }

      if (parsed.method === "tools/call") {
        // Return massive deployment logs (>2KB)
        const massiveDeploymentLogs = Array.from({ length: 60 }, (_, idx) => ({
          step: idx + 1,
          stage: `Provision node-worker-${idx}`,
          status: "SUCCESS",
          ip: `10.0.${Math.floor(idx / 256)}.${idx % 256}`,
          timestamp: new Date().toISOString(),
        }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    deploymentId: "dpl_987654321",
                    status: "DEPLOYED",
                    totalNodes: 60,
                    logs: massiveDeploymentLogs,
                  }),
                },
              ],
            },
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", () => resolve()));
  const upstreamAddr: any = upstreamServer.address();
  const upstreamUrl = `http://127.0.0.1:${upstreamAddr.port}/mcp`;

  // 2. Setup SkillPrism Proxy connected to Upstream Server with 2-turn TTL
  const index = new SkillIndex();
  const upstreamManager = new UpstreamManager();
  await upstreamManager.connectServer("cluster-service", upstreamUrl, index);

  const harness = new JitHarness(index, 2); // 2-turn TTL
  const interceptor = new McpProtocolInterceptor(harness, index);
  interceptor.setUpstreamManager(upstreamManager);

  const proxy = new SkillPrismProxyServer(interceptor);
  const AUTH_KEY = "gateway-secret-auth-key";

  await proxy.startHttp({
    port: 0,
    authToken: AUTH_KEY,
  });
  const proxyAddr = proxy.getAddress();
  assert.ok(proxyAddr);
  const gatewayUrl = `http://127.0.0.1:${proxyAddr.port}/mcp`;

  const clientHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${AUTH_KEY}`,
  };

  try {
    // Turn 1: Client queries tools/list -> only meta-tools are present (Out-of-Context index)
    const turn1Res = await fetch(gatewayUrl, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const turn1Json = await turn1Res.json();
    const initialTools = turn1Json.result.tools.map((t: any) => t.name);
    assert.deepEqual(initialTools, ["search_skills", "load_skill", "inspect_receipt"]);

    // Turn 2: Client searches for "deploy cluster nodes"
    const searchRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "search_skills",
          arguments: { intent: "deploy cluster nodes" },
        },
      }),
    });
    const searchJson = await searchRes.json();
    const searchResults = JSON.parse(searchJson.result.content[0].text);
    assert.ok(searchResults.skills.some((r: any) => r.id === "cloud_deploy_cluster"));

    // Turn 3: Client dynamically activates "cloud_deploy_cluster"
    const loadRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "load_skill",
          arguments: { skill_id: "cloud_deploy_cluster" },
        },
      }),
    });
    const loadJson = await loadRes.json();
    assert.ok(!loadJson.result.isError);

    // Verify tools/list now exposes the tool and preserved schema constraints
    const refreshedToolsRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    const refreshedToolsJson = await refreshedToolsRes.json();
    const deployedTool = refreshedToolsJson.result.tools.find(
      (t: any) => t.name === "cloud_deploy_cluster",
    );
    assert.ok(deployedTool);
    assert.equal(deployedTool.inputSchema.additionalProperties, false);
    assert.deepEqual(deployedTool.inputSchema.properties.region.enum, [
      "us-east-1",
      "eu-central-1",
      "ap-southeast-1",
    ]);

    // Turn 4: Client executes the tool with valid arguments
    const execRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "cloud_deploy_cluster",
          arguments: {
            clusterName: "prod-omega",
            region: "us-east-1",
          },
        },
      }),
    });
    const execJson = await execRes.json();
    // Upstream returned > 2KB output; verify it was compacted into an inspectable receipt!
    const receiptText = execJson.result.content[0].text;
    assert.ok(receiptText.includes("ref") || receiptText.includes("receipt_id"));
    const receiptObj = JSON.parse(receiptText);
    const receiptRef = receiptObj.ref || receiptObj.receipt_id;
    assert.ok(receiptRef.startsWith("receipt:cloud_deploy_cluster:"));

    // Turn 5: Client inspects receipt
    const inspectRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "inspect_receipt",
          arguments: { ref: receiptRef, path: "deploymentId" },
        },
      }),
    });
    const inspectJson = await inspectRes.json();
    const inspectData = JSON.parse(inspectJson.result.content[0].text);
    assert.equal(inspectData.data, "dpl_987654321");

    // Advance turns past TTL (turn count reached 2)
    harness.stepTurn();
    harness.pruneExpiredSkills();

    // Verify tool has expired and pruned back to zero-state
    const expiredToolsRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    const expiredToolsJson = await expiredToolsRes.json();
    const finalTools = expiredToolsJson.result.tools.map((t: any) => t.name);
    assert.deepEqual(finalTools, ["search_skills", "load_skill", "inspect_receipt"]);
  } finally {
    await proxy.close();
    await upstreamManager.closeAll();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});
