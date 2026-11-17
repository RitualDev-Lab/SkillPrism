export interface AnthropicCacheControl {
  type: "ephemeral";
}

export interface CachedToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export interface PromptCacheStackOptions {
  provider: "anthropic" | "openai" | "generic";
  enableAnthropicCacheControl?: boolean;
  enableOpenAiPrefixSorting?: boolean;
  cachedSystemPrompt?: string;
}

export interface StackedCompactionMetrics {
  originalTokens: number;
  prunedTokens: number;
  effectiveCachedTokens: number;
  reductionPercentage: number;
  dollarsSaved: number;
}

export class PromptCacheStack {
  private provider: "anthropic" | "openai" | "generic";
  private enableAnthropicCacheControl: boolean;
  private enableOpenAiPrefixSorting: boolean;

  constructor(options: PromptCacheStackOptions) {
    this.provider = options.provider;
    this.enableAnthropicCacheControl = options.enableAnthropicCacheControl ?? true;
    this.enableOpenAiPrefixSorting = options.enableOpenAiPrefixSorting ?? true;
  }

  /**
   * Stacks native prompt caching on top of dynamically pruned tool schemas
   */
  public prepareToolsPayload(
    activeTools: Array<{ name: string; description: string; input_schema?: Record<string, unknown>; parameters?: Record<string, unknown> }>,
  ): CachedToolDefinition[] {
    let tools: CachedToolDefinition[] = activeTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema || t.parameters || {},
    }));

    // OpenAI static prefix caching requires deterministic ordering
    if (this.enableOpenAiPrefixSorting) {
      tools = tools.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Anthropic prompt caching: place cache_control breakpoint on the last tool definition
    if (this.provider === "anthropic" && this.enableAnthropicCacheControl && tools.length > 0) {
      tools[tools.length - 1].cache_control = { type: "ephemeral" };
    }

    return tools;
  }

  /**
   * Calculates stacked token reduction metrics combining JIT pruning with prompt caching
   * Standard Anthropic prompt cache read discount: 90% (0.10x cost multiplier)
   * Standard OpenAI prompt cache read discount: 50% (0.50x cost multiplier)
   */
  public calculateStackedSavings(
    originalCatalogTokens: number,
    prunedActiveTokens: number,
    cacheHitRatio = 1.0,
    costPerMillionTokens = 3.0, // Default $3.00 / 1M input tokens
  ): StackedCompactionMetrics {
    const cacheMultiplier = this.provider === "anthropic" ? 0.10 : 0.50;
    const effectiveCachedTokens =
      prunedActiveTokens * (1 - cacheHitRatio) +
      prunedActiveTokens * cacheHitRatio * cacheMultiplier;

    const tokenReduction = originalCatalogTokens - effectiveCachedTokens;
    const reductionPercentage = (tokenReduction / originalCatalogTokens) * 100;
    const dollarsSaved = (tokenReduction / 1_000_000) * costPerMillionTokens;

    return {
      originalTokens: originalCatalogTokens,
      prunedTokens: prunedActiveTokens,
      effectiveCachedTokens: Math.round(effectiveCachedTokens),
      reductionPercentage: Number(reductionPercentage.toFixed(2)),
      dollarsSaved: Number(dollarsSaved.toFixed(4)),
    };
  }
}
