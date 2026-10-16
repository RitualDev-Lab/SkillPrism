import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { JitHarness } from "../src/harness.js";
import { SkillIndex } from "../src/index-store.js";
import { McpProtocolInterceptor } from "../src/interceptor.js";

describe("Phase 3: Ephemeral Schema Injection & MCP Protocol Interceptor Suite", () => {
  function setupTestEnvironment() {
    const index = new SkillIndex();
    index.register({
      id: "aws_s3_upload",
      name: "AWS S3 Upload",
      summary: "Uploads binary files or objects directly to Amazon S3 buckets",
      description: "Streams files with server-side encryption.",
      category: "cloud",
      tags: ["aws", "s3", "storage", "upload"],
      parameters: [
        { name: "bucket", type: "string", description: "Target S3 bucket", required: true },
        { name: "key", type: "string", description: "Destination key", required: true },
      ],
    });

    const harness = new JitHarness(index);
    const interceptor = new McpProtocolInterceptor(harness, index);
    return { index, harness, interceptor };
  }

  test("handles MCP initialize handshake conformantly", async () => {
    const { interceptor } = setupTestEnvironment();

    const res = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    assert.equal(res.id, 1);
    assert.equal(res.result?.protocolVersion, "2024-11-05");
    assert.ok(res.result?.capabilities?.tools?.listChanged);
    assert.equal(res.result?.serverInfo?.name, "SkillPrism Progressive JIT Gateway");
  });

  test("intercepts tools/list to return only zero-state meta-tools initially", async () => {
    const { interceptor } = setupTestEnvironment();

    const res = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    assert.equal(res.id, 2);
    assert.ok(Array.isArray(res.result?.tools));
    // Must have 3 meta-tools: search_skills, load_skill, inspect_receipt (aws_s3_upload is kept hidden!)
    assert.equal(res.result.tools.length, 3);
    const names = res.result.tools.map((t: any) => t.name);
    assert.ok(names.includes("search_skills"));
    assert.ok(names.includes("load_skill"));
    assert.ok(names.includes("inspect_receipt"));
    assert.ok(!names.includes("aws_s3_upload"));
  });

  test("discovers skill via search_skills and dynamically activates via load_skill", async () => {
    const { interceptor } = setupTestEnvironment();

    // 1. Model searches for skills
    const searchRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_skills",
        arguments: { intent: "upload file to s3 bucket" },
      },
    });

    assert.equal(searchRes.id, 3);
    const parsedSearch = JSON.parse(searchRes.result.content[0].text);
    assert.equal(parsedSearch.matchesFound, 1);
    assert.equal(parsedSearch.skills[0].id, "aws_s3_upload");

    // 2. Model loads skill
    const loadRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "load_skill",
        arguments: { skill_id: "aws_s3_upload" },
      },
    });

    assert.equal(loadRes.id, 4);
    assert.ok(!loadRes.result?.isError);

    // 3. Next tools/list call now seamlessly presents aws_s3_upload to model
    const listRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/list",
    });

    assert.equal(listRes.result.tools.length, 4);
    const toolNames = listRes.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("aws_s3_upload"));
  });

  test("blocks unactivated skill call and executes only once activated", async () => {
    const { interceptor } = setupTestEnvironment();

    // Mock upstream executor
    let capturedTool = "";
    let capturedArgs: any = null;
    interceptor.setUpstreamExecutor(async (tool, args) => {
      capturedTool = tool;
      capturedArgs = args;
      return { uploadStatus: "ok", etag: "9b3d5012a4f7" };
    });

    // 1. Calling unactivated skill should return JIT block error (-32002)
    const blockRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "aws_s3_upload",
        arguments: { bucket: "production-backups", key: "db-snapshot-2026.tar.gz" },
      },
    });

    assert.equal(blockRes.error?.code, -32002);
    assert.ok(blockRes.error?.message.includes("JIT Gate Block"));

    // 2. Activate skill
    await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "load_skill", arguments: { skill_id: "aws_s3_upload" } },
    });

    // 3. Now execution succeeds
    const callRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "aws_s3_upload",
        arguments: { bucket: "production-backups", key: "db-snapshot-2026.tar.gz" },
      },
    });

    assert.equal(callRes.id, 8);
    assert.equal(capturedTool, "aws_s3_upload");
    assert.equal(capturedArgs.bucket, "production-backups");

    const parsedOutput = JSON.parse(callRes.result.content[0].text);
    assert.equal(parsedOutput.uploadStatus, "ok");
    assert.equal(parsedOutput.etag, "9b3d5012a4f7");
  });

  test("handles MCP ping and version negotiation", async () => {
    const { interceptor } = setupTestEnvironment();

    const pingRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
    });
    assert.equal(pingRes.id, 99);
    assert.deepEqual(pingRes.result, {});

    const initRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 100,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    assert.equal(initRes.result.protocolVersion, "2025-03-26");
    assert.equal(initRes.result.serverInfo.version, "1.2.3");
  });

  test("tools/list returns valid MCP JSON Schema format (type: 'object', properties, required)", async () => {
    const { interceptor, harness } = setupTestEnvironment();

    // Activate aws_s3_upload
    await harness.handleMetaToolCall("load_skill", { skill_id: "aws_s3_upload" });

    const listRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/list",
    });

    assert.equal(listRes.id, 101);
    const tools = listRes.result?.tools;
    assert.ok(Array.isArray(tools));

    for (const tool of tools) {
      assert.ok(tool.name, "Tool must have name");
      assert.ok(tool.description, "Tool must have description");
      assert.equal(typeof tool.inputSchema, "object", "inputSchema must be an object");
      assert.equal(Array.isArray(tool.inputSchema), false, "inputSchema must not be an array");
      assert.equal(tool.inputSchema.type, "object", "inputSchema.type must be 'object'");
      assert.equal(typeof tool.inputSchema.properties, "object", "inputSchema.properties must be an object");
    }

    const s3Tool = tools.find((t: any) => t.name === "aws_s3_upload");
    assert.ok(s3Tool);
    assert.equal(s3Tool.inputSchema.type, "object");
    assert.ok(s3Tool.inputSchema.properties.bucket);
    assert.ok(s3Tool.inputSchema.properties.key);
    assert.deepEqual(s3Tool.inputSchema.required, ["bucket", "key"]);
  });

  test("fails closed when no upstream executor is configured and simulation is disabled", async () => {
    const { interceptor, harness } = setupTestEnvironment();

    // Activate skill
    await harness.handleMetaToolCall("load_skill", { skill_id: "aws_s3_upload" });

    // Call tool with NO upstream executor and simulation disabled (default)
    const callRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "aws_s3_upload",
        arguments: { bucket: "my-bucket", key: "file.txt" },
      },
    });

    assert.equal(callRes.id, 102);
    assert.ok(callRes.error, "Must return JSON-RPC error");
    assert.equal(callRes.error.code, -32603);
    assert.match(callRes.error.message, /No upstream executor or MCP server connected/);
    assert.match(callRes.error.message, /--dry-run-simulation/);
  });

  test("allows simulated execution when --dry-run-simulation is explicitly enabled", async () => {
    const { interceptor, harness } = setupTestEnvironment();
    interceptor.setSimulationMode(true);

    // Activate skill
    await harness.handleMetaToolCall("load_skill", { skill_id: "aws_s3_upload" });

    const callRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 103,
      method: "tools/call",
      params: {
        name: "aws_s3_upload",
        arguments: { bucket: "my-bucket", key: "file.txt" },
      },
    });

    assert.equal(callRes.id, 103);
    assert.ok(!callRes.error);
    const parsed = JSON.parse(callRes.result.content[0].text);
    assert.equal(parsed.status, "simulated");
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.skill, "aws_s3_upload");
    assert.ok(parsed.notice.includes("--dry-run-simulation"));
  });

  test("faithfully preserves upstream tool errors when execution fails", async () => {
    const { interceptor, harness } = setupTestEnvironment();

    // Configure upstream executor that throws
    interceptor.setUpstreamExecutor(async () => {
      throw new Error("S3 AccessDenied: Bucket production-backups is private");
    });

    await harness.handleMetaToolCall("load_skill", { skill_id: "aws_s3_upload" });

    const callRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 104,
      method: "tools/call",
      params: {
        name: "aws_s3_upload",
        arguments: { bucket: "production-backups", key: "secret.pem" },
      },
    });

    assert.equal(callRes.id, 104);
    assert.equal(callRes.result?.isError, true);
    assert.match(callRes.result?.content[0]?.text, /S3 AccessDenied/);
  });
});
