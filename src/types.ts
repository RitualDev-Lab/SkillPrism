/**
 * Core types for SkillPrism's Out-of-Context Skill Index & Progressive Disclosure Engine
 */

export type SkillCategory =
  | "database"
  | "cloud"
  | "api"
  | "devops"
  | "security"
  | "ai"
  | "file-system"
  | "git"
  | "general";

export interface SkillParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  default?: any;
}

export interface SkillDefinition {
  /** Unique identifier: e.g. "postgres_query" or "aws_s3_upload" */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Concise 1-line summary shown during Tier-1 search disclosure */
  summary: string;
  /** Detailed description shown only when explicitly examined or loaded */
  description: string;
  /** Categorization tag */
  category: SkillCategory;
  /** Semantic search keywords */
  tags: string[];
  /** Permission / capability requirements e.g. ["db:read", "network:outbound"] */
  permissions?: string[];
  /** Full input schema definition */
  parameters: SkillParameter[];
  /** Output schema description */
  returnType?: string;
  /** Provenance server or module */
  sourceServer?: string;
  /** Raw JSON Schema if imported from OpenAPI or MCP */
  rawSchema?: Record<string, any>;
  /** Estimated token weight if fully preloaded into context */
  tokenCostEstimate?: number;
}

export interface SkillSearchResult {
  skill: SkillDefinition;
  /** Hybrid relevance score (0.0 to 1.0) combining BM25 & Semantic Match */
  score: number;
  /** Match reason explaining why the engine selected this tool */
  matchReason: string;
  /** Lightweight token representation for Phase-2 JIT Disclosure */
  disclosureSnippet: {
    id: string;
    name: string;
    summary: string;
    category: string;
    tokenCost: number;
  };
}

export interface IndexStats {
  totalSkills: number;
  categories: Record<string, number>;
  totalIndexedTerms: number;
  averageSummaryLength: number;
  savedContextTokensEstimate: number;
}
