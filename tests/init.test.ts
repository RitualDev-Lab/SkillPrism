import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe } from "node:test";
import {
  CLAUDE_INSTRUCTIONS,
  CURSOR_INSTRUCTIONS,
  MANAGED_END_MARKER,
  MANAGED_START_MARKER,
  initProject,
  injectManagedSection,
  safePatchMcpConfig,
} from "../src/init.js";

describe("Phase 2 (S2): Managed Section Injection & Non-Destructive Safe Init Suite", () => {
  test("injectManagedSection appends managed section preserving user rules when no markers exist", () => {
    const existingRules = "# My Custom Project Rules\n- Never use any\n- Write unit tests";
    const merged = injectManagedSection(existingRules, CURSOR_INSTRUCTIONS);

    assert.ok(merged.startsWith(existingRules));
    assert.ok(merged.includes(MANAGED_START_MARKER));
    assert.ok(merged.includes(MANAGED_END_MARKER));
    assert.ok(merged.includes("search_skills"));
  });

  test("injectManagedSection updates only managed section preserving text above and below markers", () => {
    const existingRules = [
      "# Header Rules",
      "- Rule 1",
      MANAGED_START_MARKER,
      "# Outdated SkillPrism v0.1 text",
      MANAGED_END_MARKER,
      "# Footer Custom Guidelines",
      "- Keep functions under 20 lines",
    ].join("\n");

    const updated = injectManagedSection(existingRules, CURSOR_INSTRUCTIONS);

    assert.ok(updated.includes("# Header Rules"));
    assert.ok(updated.includes("- Rule 1"));
    assert.ok(updated.includes("# Footer Custom Guidelines"));
    assert.ok(updated.includes("- Keep functions under 20 lines"));
    assert.ok(!updated.includes("Outdated SkillPrism v0.1 text"));
    assert.ok(updated.includes("Prevents 10,000+ token context window explosion"));
  });

  test("safePatchMcpConfig creates clean .mcp.json when file does not exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-init-test-"));
    const configPath = path.join(tmpDir, ".mcp.json");

    const res = await safePatchMcpConfig(configPath);
    assert.equal(res.success, true);

    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.ok(config.mcpServers.skillprism);
    assert.equal(config.mcpServers.skillprism.command, "npx");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("safePatchMcpConfig preserves existing servers and creates timestamped backup", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-init-test-"));
    const configPath = path.join(tmpDir, ".mcp.json");

    const initialConfig = {
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf8");

    const res = await safePatchMcpConfig(configPath);
    assert.equal(res.success, true);
    assert.ok(res.backupPath);

    // Verify backup exists and has initial config
    const backupContent = JSON.parse(await fs.readFile(res.backupPath, "utf8"));
    assert.deepEqual(backupContent, initialConfig);

    // Verify updated file has all 3 servers
    const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.ok(updated.mcpServers.github);
    assert.ok(updated.mcpServers.postgres);
    assert.ok(updated.mcpServers.skillprism);
    assert.equal(Object.keys(updated.mcpServers).length, 3);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("S2 Regression: safePatchMcpConfig strictly aborts on invalid JSON without mutating file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-init-test-"));
    const configPath = path.join(tmpDir, ".mcp.json");

    const invalidContent = '{\n  "mcpServers": { broken json syntax here...';
    await fs.writeFile(configPath, invalidContent, "utf8");

    // Attempt patch without force
    const res = await safePatchMcpConfig(configPath, { force: false });
    assert.equal(res.success, false);
    assert.match(res.error || "", /contains invalid JSON/);
    assert.match(res.error || "", /Aborting to prevent data loss/);

    // File content MUST NOT have been overwritten
    const contentAfter = await fs.readFile(configPath, "utf8");
    assert.equal(contentAfter, invalidContent);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("safePatchMcpConfig allows force overwrite of invalid JSON when explicitly requested", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-init-test-"));
    const configPath = path.join(tmpDir, ".mcp.json");

    const invalidContent = '{\n  "corrupt": true, broken';
    await fs.writeFile(configPath, invalidContent, "utf8");

    const res = await safePatchMcpConfig(configPath, { force: true });
    assert.equal(res.success, true);
    assert.ok(res.backupPath);

    // Corrupted file was backed up before overwrite
    const backedUp = await fs.readFile(res.backupPath, "utf8");
    assert.equal(backedUp, invalidContent);

    // New file is valid JSON with skillprism server
    const newConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.ok(newConfig.mcpServers.skillprism);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("initProject non-destructively initializes .cursorrules and CLAUDE.md while backing up existing files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-init-test-"));
    const cursorPath = path.join(tmpDir, ".cursorrules");
    const claudePath = path.join(tmpDir, "CLAUDE.md");

    const originalCursor = "# Team Coding Standard\n- Follow TypeScript strict mode";
    const originalClaude = "# Project Architecture\n- Microservices in Go and Node";

    await fs.writeFile(cursorPath, originalCursor, "utf8");
    await fs.writeFile(claudePath, originalClaude, "utf8");

    const res = await initProject({ cwd: tmpDir, all: true });
    assert.equal(res.success, true);
    assert.ok(res.filesModified.includes(".cursorrules"));
    assert.ok(res.filesModified.includes("CLAUDE.md"));
    assert.ok(res.filesModified.includes(".mcp.json"));

    // Backups must exist for both files
    assert.ok(res.backupsCreated.length >= 2);

    // Verify existing content preserved in .cursorrules
    const finalCursor = await fs.readFile(cursorPath, "utf8");
    assert.ok(finalCursor.includes(originalCursor));
    assert.ok(finalCursor.includes(MANAGED_START_MARKER));
    assert.ok(finalCursor.includes("search_skills"));

    // Verify existing content preserved in CLAUDE.md
    const finalClaude = await fs.readFile(claudePath, "utf8");
    assert.ok(finalClaude.includes(originalClaude));
    assert.ok(finalClaude.includes(MANAGED_START_MARKER));
    assert.ok(finalClaude.includes("Token & Context Optimization"));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
