/**
 * Context Window Dynamic Budgeting Engine
 *
 * Automatically inspects the host LLM's context capacity (e.g. 8k, 32k, 128k, 1M tokens)
 * and dynamically tunes tool description compaction, active schema allocations, and receipt
 * payload ratios to maximize reasoning headroom for autonomous agents.
 */

import type { ContextCompactor } from "./compactor.js";
import type { JitHarness } from "./harness.js";
import type { SkillDefinition } from "./types.js";

export type ContextBudgetTier = "compact_tight" | "standard" | "large" | "massive";

export interface ContextBudgetConfig {
  /** Inferred or configured total model context capacity in tokens */
  totalContextTokens: number;
  /** Categorized capacity tier */
  tier: ContextBudgetTier;
  /** Target host model name or identifier */
  modelName: string;
  /** Maximum token budget allocated to tool schemas (5-25% of window) */
  toolSchemaBudgetTokens: number;
  /** Tokens reserved exclusively for agent reasoning, thought chain, and user dialogue */
  reasoningReserveTokens: number;
  /** Dynamic byte threshold before return payloads are compacted into semantic receipts */
  compactorByteThreshold: number;
  /** Granularity of tool description rendering */
  toolDescriptionMode: "ultra_short" | "concise" | "standard" | "verbose";
  /** Maximum key scalar fields extracted into semantic receipts */
  maxReceiptKeyFields: number;
  /** Maximum number of simultaneous active tool schemas permitted in context */
  maxActiveTools: number;
}

/** Standard Model Context Capacities (in tokens) */
const KNOWN_MODEL_CAPACITIES: Record<string, number> = {
  // Ultra-large context (1M - 2M)
  "gemini-1.5-pro": 2097152,
  "gemini-2.0-pro": 2097152,
  "gemini-1.5-flash": 1048576,
  "gemini-2.0-flash": 1048576,

  // Large context (128k - 200k)
  "claude-3-5-sonnet": 200000,
  "claude-3-opus": 200000,
  "claude-3-5-haiku": 200000,
  "claude-3-sonnet": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  o1: 128000,
  "o1-mini": 128000,
  "o3-mini": 128000,
  "llama-3.1-70b": 128000,
  "llama-3.1-405b": 128000,
  "deepseek-v3": 128000,
  "deepseek-r1": 128000,

  // Standard context (32k - 64k)
  "mistral-large": 128000,
  "mistral-small": 32768,
  "mistral-7b": 32768,
  "qwen-2.5-72b": 128000,
  "qwen-2.5-coder": 32768,
  "command-r": 128000,

  // Tight context (8k - 16k)
  "gpt-3.5-turbo": 16384,
  "gpt-4": 8192,
  "llama-3-8b": 8192,
  "llama-2-70b": 4096,
};

/**
 * Infers model context window from string identifier or environment variables
 */
export function inferModelContextWindow(modelIdentifier?: string): {
  capacityTokens: number;
  modelName: string;
} {
  const model = (
    modelIdentifier ||
    process.env.SKILLPRISM_MODEL ||
    process.env.LLM_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.GEMINI_MODEL ||
    "claude-3-5-sonnet"
  )
    .toLowerCase()
    .trim();

  // Check explicit token override environment variable
  if (process.env.CONTEXT_WINDOW_SIZE) {
    const parsed = Number.parseInt(process.env.CONTEXT_WINDOW_SIZE, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return { capacityTokens: parsed, modelName: model };
    }
  }

  // Exact match
  if (KNOWN_MODEL_CAPACITIES[model]) {
    return { capacityTokens: KNOWN_MODEL_CAPACITIES[model], modelName: model };
  }

  // Substring matching
  for (const [key, cap] of Object.entries(KNOWN_MODEL_CAPACITIES)) {
    if (model.includes(key)) {
      return { capacityTokens: cap, modelName: model };
    }
  }

  // Heuristic prefix matching
  if (model.startsWith("gemini")) return { capacityTokens: 1048576, modelName: model };
  if (model.startsWith("claude")) return { capacityTokens: 200000, modelName: model };
  if (model.startsWith("gpt-4")) return { capacityTokens: 128000, modelName: model };
  if (
    model.startsWith("llama-3.1") ||
    model.startsWith("llama-3.2") ||
    model.startsWith("llama-3.3")
  )
    return { capacityTokens: 128000, modelName: model };
  if (model.startsWith("llama-3")) return { capacityTokens: 8192, modelName: model };

  // Default fallback: 128k modern standard
  return { capacityTokens: 128000, modelName: model };
}

/**
 * Computes dynamic context budget parameters based on total capacity
 */
export function computeContextBudget(
  capacityTokens: number,
  modelName = "unknown-model",
): ContextBudgetConfig {
  if (capacityTokens < 16384) {
    // Tight Tier (<= 8k - 16k): Aggressive compaction to preserve agent scratchpad
    const toolBudget = Math.round(capacityTokens * 0.1); // 10%
    return {
      totalContextTokens: capacityTokens,
      tier: "compact_tight",
      modelName,
      toolSchemaBudgetTokens: toolBudget,
      reasoningReserveTokens: Math.round(capacityTokens * 0.75),
      compactorByteThreshold: 256, // Compact anything > 256 bytes
      toolDescriptionMode: "ultra_short",
      maxReceiptKeyFields: 3,
      maxActiveTools: 3,
    };
  }

  if (capacityTokens < 65536) {
    // Standard Tier (32k - 64k)
    const toolBudget = Math.round(capacityTokens * 0.15); // 15%
    return {
      totalContextTokens: capacityTokens,
      tier: "standard",
      modelName,
      toolSchemaBudgetTokens: toolBudget,
      reasoningReserveTokens: Math.round(capacityTokens * 0.7),
      compactorByteThreshold: 512,
      toolDescriptionMode: "concise",
      maxReceiptKeyFields: 5,
      maxActiveTools: 6,
    };
  }

  if (capacityTokens < 500000) {
    // Large Tier (128k - 200k, e.g. Claude 3.5 Sonnet / GPT-4o)
    const toolBudget = Math.round(capacityTokens * 0.2); // 20%
    return {
      totalContextTokens: capacityTokens,
      tier: "large",
      modelName,
      toolSchemaBudgetTokens: toolBudget,
      reasoningReserveTokens: Math.round(capacityTokens * 0.65),
      compactorByteThreshold: 2048,
      toolDescriptionMode: "standard",
      maxReceiptKeyFields: 10,
      maxActiveTools: 12,
    };
  }

  // Massive Tier (>= 500k, e.g. Gemini 1.5/2.0 Flash/Pro 1M+)
  const toolBudget = Math.round(capacityTokens * 0.25); // 25%
  return {
    totalContextTokens: capacityTokens,
    tier: "massive",
    modelName,
    toolSchemaBudgetTokens: toolBudget,
    reasoningReserveTokens: Math.round(capacityTokens * 0.6),
    compactorByteThreshold: 8192,
    toolDescriptionMode: "verbose",
    maxReceiptKeyFields: 20,
    maxActiveTools: 25,
  };
}

/**
 * Trims or formats a skill description based on the active budget tier
 */
export function formatDescriptionForBudget(
  skill: SkillDefinition,
  mode: ContextBudgetConfig["toolDescriptionMode"],
): string {
  switch (mode) {
    case "ultra_short":
      return skill.summary || skill.name;
    case "concise":
      return skill.summary
        ? `${skill.summary} [Category: ${skill.category}]`
        : skill.description.split("\n")[0] || skill.name;
    case "standard":
      return skill.description || skill.summary;
    case "verbose":
      return `${skill.description}\n\nCategory: ${skill.category}\nTags: ${skill.tags.join(", ")}`;
  }
}

/**
 * Context Budget Manager: Coordinates dynamic budgeting across compactor and harness
 */
export class ContextBudgetManager {
  private config: ContextBudgetConfig;

  constructor(modelIdentifier?: string) {
    const { capacityTokens, modelName } = inferModelContextWindow(modelIdentifier);
    this.config = computeContextBudget(capacityTokens, modelName);
  }

  public getConfig(): ContextBudgetConfig {
    return this.config;
  }

  public setCapacity(capacityTokens: number, modelName = "custom-model"): ContextBudgetConfig {
    this.config = computeContextBudget(capacityTokens, modelName);
    return this.config;
  }

  /**
   * Dynamically tunes an active ContextCompactor instance with calculated budget thresholds
   */
  public tuneCompactor(compactor: ContextCompactor): void {
    // Adjust threshold for return payload compaction
    if (typeof (compactor as any).setMaxByteThreshold === "function") {
      (compactor as any).setMaxByteThreshold(this.config.compactorByteThreshold);
    } else {
      (compactor as any).maxByteThreshold = this.config.compactorByteThreshold;
    }
  }

  /**
   * Dynamically tunes an active JitHarness with schema limits
   */
  public tuneHarness(harness: JitHarness): void {
    if (typeof (harness as any).setMaxActiveSkills === "function") {
      (harness as any).setMaxActiveSkills(this.config.maxActiveTools);
    }
  }
}
