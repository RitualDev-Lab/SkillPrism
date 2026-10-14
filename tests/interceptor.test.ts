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
    // Must only have search_skills & load_skill (aws_s3_upload is kept hidden!)
    assert.equal(res.result.tools.length, 2);
    const names = res.result.tools.map((t: any) => t.name);
    assert.ok(names.includes("search_skills"));
    assert.ok(names.includes("load_skill"));
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

    assert.equal(listRes.result.tools.length, 3);
    const toolNames = listRes.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("aws_s3_upload"));
  });

  test("executes loaded skill through upstream executor handler", async () => {
    const { interceptor } = setupTestEnvironment();

    // Mock upstream executor
    let capturedTool = "";
    let capturedArgs: any = null;
    interceptor.setUpstreamExecutor(async (tool, args) => {
      capturedTool = tool;
      capturedArgs = args;
      return { uploadStatus: "ok", etag: "9b3d5012a4f7" };
    });

    const callRes = await interceptor.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "aws_s3_upload",
        arguments: {
          bucket: "production-backups",
          key: "db-snapshot-2026.tar.gz",
        },
      },
    });

    assert.equal(callRes.id, 6);
    assert.equal(capturedTool, "aws_s3_upload");
    assert.equal(capturedArgs.bucket, "production-backups");

    const parsedOutput = JSON.parse(callRes.result.content[0].text);
    assert.equal(parsedOutput.uploadStatus, "ok");
    assert.equal(parsedOutput.etag, "9b3d5012a4f7");
  });
});
