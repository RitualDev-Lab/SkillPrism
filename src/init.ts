import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MANAGED_START_MARKER = "<!-- SKILLPRISM:START -->";
export const MANAGED_END_MARKER = "<!-- SKILLPRISM:END -->";

export const CURSOR_INSTRUCTIONS = `${MANAGED_START_MARKER}
# SkillPrism Progressive Skill Disclosure & Context Compaction
# Prevents 10,000+ token context window explosion via JIT discovery & semantic receipts

You are paired with SkillPrism (https://skillprism.ritualdev.in).
Instead of dumping full tool schemas or massive payload JSONs:
1. Always search tools by intent via \`search_skills\` before executing unfamiliar actions.
2. Load only the specific tool needed for the current step via \`load_skill\`.
3. Read semantic receipts (\`receipt:...\`) via \`inspect_receipt\` rather than asking for full raw payload dumps.
${MANAGED_END_MARKER}`;

export const CLAUDE_INSTRUCTIONS = `${MANAGED_START_MARKER}
# SkillPrism Configuration for Claude Code

## Token & Context Optimization
- **Proxy Command**: \`npx -y @ritualdev-lab/skillprism proxy --stdio\`
- **Out-of-Context Tools**: Keep tool definitions in SkillPrism index to save 97.3% upfront token context.
- **Semantic Receipts**: When operations return heavy payloads (> 512 bytes), inspect receipts rather than dumping raw JSON.
${MANAGED_END_MARKER}`;

export interface InitOptions {
  cwd?: string;
  cursor?: boolean;
  claude?: boolean;
  all?: boolean;
  force?: boolean;
  backup?: boolean;
}

export interface InitResult {
  success: boolean;
  filesModified: string[];
  backupsCreated: string[];
  warnings: string[];
  errors: string[];
}

/**
 * Injects or updates a managed section inside existing content without
 * destroying pre-existing user instructions or rules.
 */
export function injectManagedSection(
  existingContent: string,
  newSection: string,
): string {
  if (!existingContent || existingContent.trim().length === 0) {
    return `${newSection}\n`;
  }

  const startIndex = existingContent.indexOf(MANAGED_START_MARKER);
  const endIndex = existingContent.indexOf(MANAGED_END_MARKER);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = existingContent.slice(0, startIndex);
    const after = existingContent.slice(endIndex + MANAGED_END_MARKER.length);
    return `${before}${newSection}${after}`;
  }

  // No existing managed markers: append managed section preserving all original content
  const cleanExisting = existingContent.trimEnd();
  return `${cleanExisting}\n\n${newSection}\n`;
}

/**
 * Creates a timestamped backup of a file if it exists.
 */
export async function createTimestampedBackup(
  filePath: string,
): Promise<string | null> {
  try {
    await fs.access(filePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${filePath}.bak.${timestamp}`;
    const content = await fs.readFile(filePath, "utf8");
    await fs.writeFile(backupPath, content, "utf8");

    // Also update generic .bak for quick reference
    const genericBakPath = `${filePath}.bak`;
    await fs.writeFile(genericBakPath, content, "utf8");

    return backupPath;
  } catch {
    return null;
  }
}

/**
 * Safely updates or creates .mcp.json without overwriting pre-existing servers
 * and strictly aborting if the existing file contains invalid JSON.
 */
export async function safePatchMcpConfig(
  mcpConfigPath: string,
  options: { force?: boolean; backup?: boolean } = {},
): Promise<{ success: boolean; backupPath?: string; error?: string }> {
  let fileExists = false;
  let rawExisting = "";

  try {
    rawExisting = await fs.readFile(mcpConfigPath, "utf8");
    fileExists = true;
  } catch {
    fileExists = false;
  }

  let backupPath: string | undefined;

  if (fileExists) {
    let parsedConfig: any;
    try {
      parsedConfig = JSON.parse(rawExisting);
    } catch (parseErr: any) {
      if (!options.force) {
        return {
          success: false,
          error: `Existing configuration '${mcpConfigPath}' contains invalid JSON: ${parseErr.message}. Aborting to prevent data loss. Pass --force to overwrite.`,
        };
      }
      // Force enabled: create backup of the corrupt file before replacing
      const createdBackup = await createTimestampedBackup(mcpConfigPath);
      backupPath = createdBackup ?? undefined;
      parsedConfig = {};
    }

    if (options.backup !== false && !backupPath) {
      const createdBackup = await createTimestampedBackup(mcpConfigPath);
      backupPath = createdBackup ?? undefined;
    }

    if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
      parsedConfig = {};
    }
    if (!parsedConfig.mcpServers || typeof parsedConfig.mcpServers !== "object") {
      parsedConfig.mcpServers = {};
    }

    parsedConfig.mcpServers.skillprism = {
      command: "npx",
      args: ["-y", "@ritualdev-lab/skillprism", "proxy", "--stdio"],
    };

    await fs.writeFile(mcpConfigPath, JSON.stringify(parsedConfig, null, 2), "utf8");
    return { success: true, backupPath };
  }

  // File does not exist: create fresh .mcp.json
  const freshConfig = {
    mcpServers: {
      skillprism: {
        command: "npx",
        args: ["-y", "@ritualdev-lab/skillprism", "proxy", "--stdio"],
      },
    },
  };

  await fs.writeFile(mcpConfigPath, JSON.stringify(freshConfig, null, 2), "utf8");
  return { success: true };
}

/**
 * Non-destructive initialization for Cursor, Claude Code, and MCP clients.
 */
export async function initProject(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd || process.cwd();
  const isCursor = options.cursor || (!options.claude && !options.all);
  const isClaude = options.claude || options.all;
  const force = Boolean(options.force);
  const shouldBackup = options.backup !== false;

  const filesModified: string[] = [];
  const backupsCreated: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Initialize .cursorrules
  if (isCursor || options.all) {
    const cursorRulesPath = path.resolve(cwd, ".cursorrules");
    try {
      let existing = "";
      try {
        existing = await fs.readFile(cursorRulesPath, "utf8");
        if (shouldBackup) {
          const bak = await createTimestampedBackup(cursorRulesPath);
          if (bak) backupsCreated.push(bak);
        }
      } catch {
        // File does not exist yet
      }

      const merged = injectManagedSection(existing, CURSOR_INSTRUCTIONS);
      await fs.writeFile(cursorRulesPath, merged, "utf8");
      filesModified.push(".cursorrules");
    } catch (err: any) {
      errors.push(`Failed to update .cursorrules: ${err.message}`);
    }
  }

  // 2. Initialize CLAUDE.md
  if (isClaude || options.all) {
    const claudeMdPath = path.resolve(cwd, "CLAUDE.md");
    try {
      let existing = "";
      try {
        existing = await fs.readFile(claudeMdPath, "utf8");
        if (shouldBackup) {
          const bak = await createTimestampedBackup(claudeMdPath);
          if (bak) backupsCreated.push(bak);
        }
      } catch {
        // File does not exist yet
      }

      const merged = injectManagedSection(existing, CLAUDE_INSTRUCTIONS);
      await fs.writeFile(claudeMdPath, merged, "utf8");
      filesModified.push("CLAUDE.md");
    } catch (err: any) {
      errors.push(`Failed to update CLAUDE.md: ${err.message}`);
    }
  }

  // 3. Patch .mcp.json safely
  const mcpConfigPath = path.resolve(cwd, ".mcp.json");
  const patchResult = await safePatchMcpConfig(mcpConfigPath, {
    force,
    backup: shouldBackup,
  });

  if (patchResult.success) {
    filesModified.push(".mcp.json");
    if (patchResult.backupPath) {
      backupsCreated.push(patchResult.backupPath);
    }
  } else if (patchResult.error) {
    errors.push(patchResult.error);
  }

  return {
    success: errors.length === 0,
    filesModified,
    backupsCreated,
    warnings,
    errors,
  };
}
