import { encode } from "gpt-tokenizer";
import { BM25Engine } from "./bm25.js";
import type { IndexStats, SkillDefinition, SkillSearchResult } from "./types.js";

/**
 * SkillIndex
 * High-performance, out-of-context skill registry with serialization support.
 * Keeps hundreds of heavy tool schemas OUT of the LLM prompt until explicitly requested.
 */
export class SkillIndex {
  private skills: Map<string, SkillDefinition> = new Map();
  private bm25: BM25Engine = new BM25Engine();

  /**
   * Register a new skill into the out-of-context catalog
   */
  public register(skill: SkillDefinition): void {
    // Clone to avoid mutating caller object
    const storedSkill: SkillDefinition = {
      ...skill,
      tags: skill.tags || [],
      permissions: skill.permissions || [],
      parameters: skill.parameters || [],
    };

    if (!storedSkill.tokenCostEstimate) {
      try {
        storedSkill.tokenCostEstimate = encode(JSON.stringify(storedSkill)).length;
      } catch {
        storedSkill.tokenCostEstimate = Math.ceil(JSON.stringify(storedSkill).length / 3.8);
      }
    }

    this.skills.set(storedSkill.id, storedSkill);

    // Build searchable document text prioritizing name, tags, summary, and parameters
    const searchableContent = [
      storedSkill.name,
      storedSkill.id,
      storedSkill.summary,
      storedSkill.description,
      storedSkill.category,
      ...(storedSkill.tags || []),
      ...(storedSkill.permissions || []),
      ...storedSkill.parameters.map((p) => `${p.name} ${p.description} ${p.type}`),
    ].join(" ");

    this.bm25.addDocument(storedSkill.id, searchableContent);
  }

  /**
   * Serialize entire index to JSON string for local persistence (e.g. .skillprism.json)
   */
  public exportToJson(): string {
    const list = Array.from(this.skills.values());
    return JSON.stringify(
      { version: "1.1.1", exportedAt: new Date().toISOString(), skills: list },
      null,
      2,
    );
  }

  /**
   * Hydrate index from JSON string
   */
  public importFromJson(jsonStr: string): number {
    const parsed = JSON.parse(jsonStr);
    const skills: SkillDefinition[] = Array.isArray(parsed) ? parsed : parsed.skills || [];
    let imported = 0;
    for (const s of skills) {
      this.register(s);
      imported++;
    }
    return imported;
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

  private static readonly SYNONYM_MAP: Record<string, string[]> = {
    file: ["upload", "storage", "s3", "bucket", "blob", "read", "write"],
    store: ["save", "upload", "put", "storage", "s3", "database"],
    save: ["store", "upload", "put", "persist", "insert"],
    query: ["select", "fetch", "search", "find", "get", "read", "sql"],
    database: ["db", "postgres", "sql", "warehouse", "table", "records"],
    payment: ["charge", "stripe", "billing", "invoice", "checkout"],
    deploy: ["kubernetes", "k8s", "cloud", "docker", "release", "container"],
    pods: ["kubernetes", "k8s", "containers", "cluster"],
  };

  /**
   * Search for skills matching intent using hybrid BM25 and semantic synonym expansion
   */
  public search(intent: string, maxResults = 5): SkillSearchResult[] {
    // Expand query with domain synonyms for paraphrase coverage (e.g. "store a file" -> "s3 upload")
    const lowerTokens = intent.toLowerCase().split(/[\s_\-]+/);
    const expandedTerms = new Set<string>(lowerTokens);
    for (const token of lowerTokens) {
      const synonyms = SkillIndex.SYNONYM_MAP[token];
      if (synonyms) {
        for (const syn of synonyms) expandedTerms.add(syn);
      }
    }
    const expandedQuery = Array.from(expandedTerms).join(" ");

    const rawScores = this.bm25.search(expandedQuery);
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

      let normalizedScore = maxScore > 0 ? Number((rawScore / maxScore).toFixed(4)) : 0;

      // Check for exact keyword hits for match reason
      const lowerIntent = intent.toLowerCase();
      let matchReason = "Relevance rank based on intent terms";
      const tags = skill.tags || [];
      if (tags.some((t) => lowerIntent.includes(String(t).toLowerCase()))) {
        matchReason = "Matched domain tag and operation keyword";
        normalizedScore = Math.min(1.0, normalizedScore + 0.1);
      } else if (lowerIntent.includes(skill.name.toLowerCase())) {
        matchReason = "Direct name keyword correlation";
        normalizedScore = Math.min(1.0, normalizedScore + 0.15);
      } else {
        matchReason = "Semantic intent correlation & synonym match";
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
  public importFromMcp(
    toolsList: Array<{ name: string; description?: string; inputSchema?: any }>,
  ): number {
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
      const cleanDesc = rawDesc
        .replace(/[<>{}`$]/g, "")
        .slice(0, 300)
        .trim();
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
   * Import tools from OpenAPI 3.0 / 3.1 specification (JSON string or object)
   */
  public importFromOpenApi(spec: any): number {
    const doc = typeof spec === "string" ? JSON.parse(spec) : spec;
    const paths = doc.paths || {};
    let count = 0;

    for (const [pathUrl, methods] of Object.entries<any>(paths)) {
      for (const [method, op] of Object.entries<any>(methods)) {
        if (["get", "post", "put", "delete", "patch"].indexOf(method.toLowerCase()) === -1)
          continue;

        const operationId =
          op.operationId ||
          `${method}_${pathUrl.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_+|_+$/g, "")}`;
        const safeId = operationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        const summary = op.summary || op.description || `${method.toUpperCase()} ${pathUrl}`;
        const description =
          op.description || op.summary || `API endpoint ${method.toUpperCase()} ${pathUrl}`;

        const parameters: any[] = [];
        // Path/query parameters
        if (Array.isArray(op.parameters)) {
          for (const p of op.parameters) {
            parameters.push({
              name: p.name,
              type: p.schema?.type || "string",
              description: (p.description || `Parameter ${p.name}`).slice(0, 120),
              required: Boolean(p.required),
            });
          }
        }
        // RequestBody schema
        const requestBody = op.requestBody?.content?.["application/json"]?.schema;
        if (requestBody?.properties) {
          const req = requestBody.required || [];
          for (const [propName, propDef] of Object.entries<any>(requestBody.properties)) {
            parameters.push({
              name: propName,
              type: propDef.type || "string",
              description: (propDef.description || `Body property ${propName}`).slice(0, 120),
              required: req.includes(propName),
            });
          }
        }

        const tags: string[] = Array.isArray(op.tags) ? op.tags : [];
        tags.push(method.toLowerCase(), "openapi");

        const rawCat = tags[0] || "api";
        const validCategories = [
          "database",
          "cloud",
          "api",
          "devops",
          "security",
          "ai",
          "file-system",
          "git",
          "general",
        ];
        const category = validCategories.includes(rawCat) ? (rawCat as any) : "api";

        this.register({
          id: safeId,
          name: op.summary || safeId.replace(/_/g, " "),
          summary: summary.slice(0, 120),
          description: description.slice(0, 300),
          category,
          tags,
          parameters,
        });
        count++;
      }
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
      averageSummaryLength:
        this.skills.size > 0 ? Math.round(totalSummaryLength / this.skills.size) : 0,
      savedContextTokensEstimate: savedTokens,
    };
  }
}
