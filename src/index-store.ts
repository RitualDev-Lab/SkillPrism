import { BM25Engine } from "./bm25.js";
import type { IndexStats, SkillDefinition, SkillSearchResult } from "./types.js";

/**
 * SkillIndex
 * High-performance, in-memory/out-of-context skill registry.
 * Keeps hundreds of heavy tool schemas OUT of the LLM prompt until explicitly requested.
 */
export class SkillIndex {
  private skills: Map<string, SkillDefinition> = new Map();
  private bm25: BM25Engine = new BM25Engine();

  /**
   * Register a new skill into the out-of-context catalog
   */
  public register(skill: SkillDefinition): void {
    // Estimate token weight if not provided
    if (!skill.tokenCostEstimate) {
      const rawText = JSON.stringify(skill);
      skill.tokenCostEstimate = Math.ceil(rawText.length / 3.8);
    }

    this.skills.set(skill.id, skill);

    // Build searchable document text prioritizing name, tags, summary, and parameters
    const searchableContent = [
      skill.name,
      skill.id,
      skill.summary,
      skill.description,
      skill.category,
      ...(skill.tags || []),
      ...(skill.permissions || []),
      ...skill.parameters.map((p) => `${p.name} ${p.description} ${p.type}`),
    ].join(" ");

    this.bm25.addDocument(skill.id, searchableContent);
  }

  /**
   * Batch register multiple skills
   */
  public registerBatch(skills: SkillDefinition[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /**
   * Retrieve a skill definition by its exact ID
   */
  public get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  /**
   * Search for skills matching intent using hybrid BM25 and keyword affinity
   */
  public search(intent: string, maxResults = 5): SkillSearchResult[] {
    const rawScores = this.bm25.search(intent);
    const results: SkillSearchResult[] = [];

    // Find maximum score for normalization
    let maxScore = 0;
    for (const score of rawScores.values()) {
      if (score > maxScore) maxScore = score;
    }

    for (const [id, rawScore] of rawScores.entries()) {
      if (rawScore <= 0) continue;
      const skill = this.skills.get(id);
      if (!skill) continue;

      const normalizedScore = maxScore > 0 ? Number((rawScore / maxScore).toFixed(4)) : 0;

      // Check for exact keyword hits for match reason
      const lowerIntent = intent.toLowerCase();
      let matchReason = "Relevance rank based on intent terms";
      if (skill.tags.some((t) => lowerIntent.includes(t.toLowerCase()))) {
        matchReason = "Matched domain tag and operation keyword";
      } else if (lowerIntent.includes(skill.name.toLowerCase())) {
        matchReason = "Direct name keyword correlation";
      }

      results.push({
        skill,
        score: normalizedScore,
        matchReason,
        disclosureSnippet: {
          id: skill.id,
          name: skill.name,
          summary: skill.summary,
          category: skill.category,
          tokenCost: skill.tokenCostEstimate || 250,
        },
      });
    }

    // Sort descending by score and limit
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  /**
   * Import tools from standard Model Context Protocol (MCP) tools/list response
   * Includes prompt injection sanitization, tag bounding, and description length capping.
   */
  public importFromMcp(toolsList: Array<{ name: string; description?: string; inputSchema?: any }>): number {
    let count = 0;
    for (const tool of toolsList) {
      const parameters: any[] = [];
      const properties = tool.inputSchema?.properties || {};
      const required = tool.inputSchema?.required || [];

      for (const [propName, propDef] of Object.entries<any>(properties)) {
        // Sanitize parameter descriptions and cap length to prevent injection payloads
        const cleanParamDesc = (propDef.description || "")
          .replace(/[<>{}`$]/g, "")
          .slice(0, 160)
          .trim();

        parameters.push({
          name: propName,
          type: propDef.type || "string",
          description: cleanParamDesc,
          required: required.includes(propName),
        });
      }

      // Sanitize tool name and descriptions against prompt poisoning
      const safeName = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      const rawDesc = tool.description || `Tool: ${safeName}`;
      // Strip control / template escape characters and cap description length
      const cleanDesc = rawDesc.replace(/[<>{}`$]/g, "").slice(0, 300).trim();
      const cleanSummary = cleanDesc.slice(0, 120);

      this.register({
        id: safeName,
        name: safeName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        summary: cleanSummary || `Executes ${safeName}`,
        description: cleanDesc,
        category: "general",
        tags: [safeName, "mcp-tool"],
        parameters,
        rawSchema: tool.inputSchema,
      });
      count++;
    }
    return count;
  }

  /**
   * Produce comprehensive index telemetry
   */
  public getStats(): IndexStats {
    const categories: Record<string, number> = {};
    let totalSummaryLength = 0;
    let savedTokens = 0;

    for (const skill of this.skills.values()) {
      categories[skill.category] = (categories[skill.category] || 0) + 1;
      totalSummaryLength += skill.summary.length;
      savedTokens += skill.tokenCostEstimate || 300;
    }

    return {
      totalSkills: this.skills.size,
      categories,
      totalIndexedTerms: this.bm25.getTotalTerms(),
      averageSummaryLength: this.skills.size > 0 ? Math.round(totalSummaryLength / this.skills.size) : 0,
      savedContextTokensEstimate: savedTokens,
    };
  }
}
