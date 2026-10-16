import type { SkillIndex } from "./index-store.js";
import { toMcpInputSchema } from "./interceptor.js";
import type { SkillDefinition } from "./types.js";

/**
 * Standard Tool Definition representation compatible with
 * OpenAI Function Calling, Anthropic Claude Tool Use, and Model Context Protocol.
 */
export interface MetaToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
  };
}

export interface ActivatedSkillTurn {
  skillId: string;
  toolSchema: MetaToolDefinition;
  activatedAtTurn: number;
  expiresAtTurn: number;
  activatedAtMs: number;
  expiresAtMs: number;
}

export interface MetaToolCallResult {
  tool: string;
  status: "success" | "error";
  data?: any;
  error?: string;
  injectedToolSchema?: MetaToolDefinition;
}

/**
 * JitHarness
 * The zero-state gateway for Autonomous AI Coding Agents.
 * Replaces 200+ raw tool schemas with 2 lightweight meta-tools:
 * 1. `search_skills`: Discovers abilities on demand.
 * 2. `load_skill`: Dynamically activates a skill's full schema for the active turn.
 */
export class JitHarness {
  private index: SkillIndex;
  private currentTurn = 1;
  private activeSkills: Map<string, ActivatedSkillTurn> = new Map();
  private defaultTtlTurns: number;
  private defaultIdleTtlMs: number;
  private onToolsChangedListeners: Array<() => void> = [];

  constructor(
    index: SkillIndex,
    defaultTtlTurns = 3,
    defaultIdleTtlMs = 1000 * 60 * 10,
  ) {
    this.index = index;
    this.defaultTtlTurns = defaultTtlTurns;
    this.defaultIdleTtlMs = defaultIdleTtlMs;
  }

  public getDefaultTtlTurns(): number {
    return this.defaultTtlTurns;
  }

  public getDefaultIdleTtlMs(): number {
    return this.defaultIdleTtlMs;
  }

  /**
   * Register a listener invoked whenever active tool definitions are added or pruned
   */
  public onToolsChanged(listener: () => void): () => void {
    this.onToolsChangedListeners.push(listener);
    return () => {
      this.onToolsChangedListeners = this.onToolsChangedListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Emit notification to all subscribed listeners that the tool registry has changed
   */
  public emitToolsChanged(): void {
    for (const listener of this.onToolsChangedListeners) {
      try {
        listener();
      } catch {
        // Guard against listener exceptions
      }
    }
  }

  /**
   * Returns the minimal zero-state meta-tool definitions (~150 tokens)
   * passed to the model in turn 1 instead of 25,000+ tokens of bloated schemas.
   */
  public getZeroStateTools(): MetaToolDefinition[] {
    return [
      {
        name: "search_skills",
        description:
          "Search the out-of-context skill registry for available tools and abilities matching your intent.",
        parameters: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              description:
                "What action or tool you need (e.g., 'query postgres table', 'upload file to S3')",
            },
            limit: {
              type: "number",
              description: "Maximum candidates to retrieve (default: 3)",
            },
          },
          required: ["intent"],
        },
      },
      {
        name: "load_skill",
        description:
          "Dynamically loads the full parameter schema and activates an identified skill for your subsequent execution turn.",
        parameters: {
          type: "object",
          properties: {
            skill_id: {
              type: "string",
              description:
                "The unique identifier of the skill to activate (e.g., 'postgres_query')",
            },
          },
          required: ["skill_id"],
        },
      },
      {
        name: "inspect_receipt",
        description:
          "Inspects compacted execution receipts stored in the out-of-context vault. Query full data or drill down into specific sub-paths.",
        parameters: {
          type: "object",
          properties: {
            ref: {
              type: "string",
              description:
                "The receipt reference token returned by a compacted tool (e.g. 'receipt:sample_exec:4a7f9b8c')",
            },
            path: {
              type: "string",
              description: "Optional dot/bracket property path to extract (e.g. 'users.0.email')",
            },
          },
          required: ["ref"],
        },
      },
    ];
  }

  /**
   * Checks whether a specific skill is currently activated and unexpired
   */
  public isSkillActive(skillId: string): boolean {
    this.pruneExpiredSkills();
    return this.activeSkills.has(skillId);
  }

  /**
   * Get all tools currently active in this reasoning turn:
   * Combines the meta-tools + any dynamically activated skill schemas.
   */
  public getActiveTools(): MetaToolDefinition[] {
    this.pruneExpiredSkills();
    const tools = [...this.getZeroStateTools()];

    for (const active of this.activeSkills.values()) {
      tools.push(active.toolSchema);
    }

    return tools;
  }

  /**
   * Execute a meta-tool invocation called by the LLM
   */
  public async handleMetaToolCall(
    name: string,
    args: Record<string, any>,
  ): Promise<MetaToolCallResult> {
    if (name === "search_skills") {
      const intent = args.intent;
      const limit = typeof args.limit === "number" ? args.limit : 3;
      if (!intent) {
        return { tool: name, status: "error", error: "Missing required parameter 'intent'" };
      }

      const matches = this.index.search(intent, limit);
      const results = matches.map((m) => ({
        id: m.skill.id,
        name: m.skill.name,
        summary: m.skill.summary,
        category: m.skill.category,
        permissions: m.skill.permissions || [],
        matchReason: m.matchReason,
        howToActivate: `Call load_skill({ skill_id: "${m.skill.id}" }) to invoke this tool.`,
      }));

      return {
        tool: name,
        status: "success",
        data: {
          query: intent,
          matchesFound: results.length,
          skills: results,
        },
      };
    }

    if (name === "load_skill") {
      const skillId = args.skill_id;
      if (!skillId) {
        return { tool: name, status: "error", error: "Missing required parameter 'skill_id'" };
      }

      const skill = this.index.get(skillId);
      if (!skill) {
        return {
          tool: name,
          status: "error",
          error: `Skill '${skillId}' was not found in the out-of-context registry. Use search_skills() to locate valid IDs.`,
        };
      }

      const toolSchema = this.convertToToolDefinition(skill);

      const now = Date.now();
      this.activeSkills.set(skillId, {
        skillId,
        toolSchema,
        activatedAtTurn: this.currentTurn,
        expiresAtTurn: this.currentTurn + this.defaultTtlTurns,
        activatedAtMs: now,
        expiresAtMs: now + this.defaultIdleTtlMs,
      });

      // Emit change notification to dynamic MCP clients
      this.emitToolsChanged();

      return {
        tool: name,
        status: "success",
        data: {
          message: `Skill '${skill.name}' successfully activated for execution. Its schema is now available in your active toolset.`,
          skillId: skill.id,
          expiresInTurns: this.defaultTtlTurns,
          expiresInMs: this.defaultIdleTtlMs,
        },
        injectedToolSchema: toolSchema,
      };
    }

    return {
      tool: name,
      status: "error",
      error: `Unknown meta-tool '${name}'`,
    };
  }

  /**
   * Convert a SkillDefinition into standard LLM tool format
   */
  public convertToToolDefinition(skill: SkillDefinition): MetaToolDefinition {
    if (skill.rawSchema) {
      const normalized = toMcpInputSchema(skill.rawSchema);
      return {
        name: skill.id,
        description: skill.description || skill.summary,
        parameters: {
          type: "object",
          properties: normalized.properties,
          required: normalized.required || [],
        },
      };
    }

    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const param of skill.parameters) {
      properties[param.name] = {
        type: param.type,
        description: param.description,
      };
      if (param.required) {
        required.push(param.name);
      }
    }

    return {
      name: skill.id,
      description: skill.description || skill.summary,
      parameters: {
        type: "object",
        properties,
        required,
      },
    };
  }

  /**
   * Refreshes the sliding inactivity window of an active skill upon execution
   */
  public touchSkill(skillId: string): void {
    const active = this.activeSkills.get(skillId);
    if (active) {
      active.expiresAtMs = Date.now() + this.defaultIdleTtlMs;
    }
  }

  /**
   * Unload a specific skill manually and notify listeners
   */
  public unloadSkill(skillId: string): boolean {
    const deleted = this.activeSkills.delete(skillId);
    if (deleted) {
      this.emitToolsChanged();
    }
    return deleted;
  }

  /**
   * Reset all active ephemeral skills
   */
  public reset(): void {
    if (this.activeSkills.size > 0) {
      this.activeSkills.clear();
      this.emitToolsChanged();
    }
  }

  /**
   * Advance turn counter & prune skills whose TTL has expired
   */
  public stepTurn(): number {
    this.currentTurn++;
    this.pruneExpiredSkills();
    return this.currentTurn;
  }

  public getCurrentTurn(): number {
    return this.currentTurn;
  }

  public getActiveSkillCount(): number {
    this.pruneExpiredSkills();
    return this.activeSkills.size;
  }

  /**
   * Prunes skills that have exceeded either their turn TTL or idle wall-clock TTL.
   */
  public pruneExpiredSkills(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, active] of this.activeSkills.entries()) {
      const turnExpired = this.currentTurn >= active.expiresAtTurn;
      const timeExpired = active.expiresAtMs !== undefined && now >= active.expiresAtMs;
      if (turnExpired || timeExpired) {
        this.activeSkills.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.emitToolsChanged();
    }
    return pruned;
  }
}
