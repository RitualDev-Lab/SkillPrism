import { BM25Engine } from "./bm25.js";
import { FastTextEmbeddingEngine } from "./embeddings.js";

/**
 * Tool definition for semantic discovery
 */
export interface DiscoverableTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  category?: string;
  rawDefinition?: unknown;
}

export interface RrfSearchResult {
  tool: DiscoverableTool;
  rrfScore: number;
  denseRank: number;
  sparseRank: number;
  denseScore: number;
  sparseScore: number;
}

/**
 * Reciprocal Rank Fusion (RRF) Discovery Engine.
 * Blends dense neural vector embeddings with Okapi BM25 lexical relevance
 * to perform sub-millisecond on-device tool discovery.
 */
export class RrfDiscoveryEngine {
  private readonly kSmooth: number;
  private readonly bm25: BM25Engine;
  private readonly tools = new Map<string, DiscoverableTool>();
  private readonly denseEmbeddings = new Map<string, number[]>();

  constructor(kSmooth = 60) {
    this.kSmooth = kSmooth;
    this.bm25 = new BM25Engine();
  }

  /**
   * Registers a tool into the RRF index, generating dense and sparse index entries
   */
  public registerTool(tool: DiscoverableTool): void {
    const fullText = `${tool.name} ${tool.category ?? ""} ${tool.description} ${
      tool.parameters ? JSON.stringify(tool.parameters) : ""
    }`;

    this.tools.set(tool.name, tool);
    this.bm25.addDocument(tool.name, fullText);

    // Compute dense embedding vector (zero-network sub-millisecond fasttext hashing)
    const vector = FastTextEmbeddingEngine.embed(fullText);
    this.denseEmbeddings.set(tool.name, vector);
  }

  public registerTools(tools: DiscoverableTool[]): void {
    for (const t of tools) {
      this.registerTool(t);
    }
  }

  /**
   * Cosine similarity between two float vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Discovers top-K relevant tools using Reciprocal Rank Fusion (RRF)
   */
  public discover(query: string, topK = 5): RrfSearchResult[] {
    if (this.tools.size === 0) return [];

    const queryTerms = this.bm25.tokenize(query);
    const queryVector = FastTextEmbeddingEngine.embed(query);

    // 1. Sparse BM25 Scoring
    const bm25Map = this.bm25.search(query);
    const bm25Scores: { name: string; score: number }[] = [];
    for (const [name] of this.tools) {
      const score = bm25Map.get(name) ?? 0;
      bm25Scores.push({ name, score });
    }
    bm25Scores.sort((a, b) => b.score - a.score);

    const sparseRankMap = new Map<string, { rank: number; score: number }>();
    bm25Scores.forEach((item, index) => {
      sparseRankMap.set(item.name, { rank: index + 1, score: item.score });
    });

    // 2. Dense Vector Scoring
    const denseScores: { name: string; score: number }[] = [];
    for (const [name, vec] of this.denseEmbeddings) {
      const sim = this.cosineSimilarity(queryVector, vec);
      denseScores.push({ name, score: sim });
    }
    denseScores.sort((a, b) => b.score - a.score);

    const denseRankMap = new Map<string, { rank: number; score: number }>();
    denseScores.forEach((item, index) => {
      denseRankMap.set(item.name, { rank: index + 1, score: item.score });
    });

    // 3. Reciprocal Rank Fusion
    const fusedResults: RrfSearchResult[] = [];
    for (const [name, tool] of this.tools) {
      const sparse = sparseRankMap.get(name) ?? { rank: this.tools.size, score: 0 };
      const dense = denseRankMap.get(name) ?? { rank: this.tools.size, score: 0 };

      const rrfScore = 1.0 / (this.kSmooth + sparse.rank) + 1.0 / (this.kSmooth + dense.rank);

      fusedResults.push({
        tool,
        rrfScore,
        denseRank: dense.rank,
        sparseRank: sparse.rank,
        denseScore: dense.score,
        sparseScore: sparse.score,
      });
    }

    // Sort descending by RRF score
    fusedResults.sort((a, b) => b.rrfScore - a.rrfScore);

    return fusedResults.slice(0, topK);
  }

  public getToolCount(): number {
    return this.tools.size;
  }

  public clear(): void {
    this.tools.clear();
    this.denseEmbeddings.clear();
  }
}
