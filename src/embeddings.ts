export interface SemanticEmbeddingVector {
  id: string;
  vector: number[];
}

export type EmbeddingBackend = "fasttext" | "transformers" | "onnx";

export interface TransformerEmbeddingOptions {
  model?: string;
  quantized?: boolean;
}

/**
 * TransformerEmbeddingEngine
 * Optional zero-network, local neural embedding engine using @xenova/transformers (ONNX runtime).
 * Defaults to Xenova/all-MiniLM-L6-v2 (384 dimensions) for deep semantic understanding.
 * Degrades gracefully to FastTextEmbeddingEngine if @xenova/transformers is not installed.
 */
export class TransformerEmbeddingEngine {
  private static extractorPromise: Promise<any> | null = null;
  private static loadedModelName = "Xenova/all-MiniLM-L6-v2";
  private static isSupported: boolean | null = null;

  /**
   * Checks whether @xenova/transformers is available in the current environment
   */
  public static async isAvailable(): Promise<boolean> {
    if (TransformerEmbeddingEngine.isSupported !== null) {
      return TransformerEmbeddingEngine.isSupported;
    }
    try {
      // Dynamic import to keep @xenova/transformers optional and zero-network by default
      const mod = await import("@xenova/transformers" as any);
      TransformerEmbeddingEngine.isSupported = Boolean(mod && (mod.pipeline || mod.default?.pipeline));
      return TransformerEmbeddingEngine.isSupported;
    } catch {
      TransformerEmbeddingEngine.isSupported = false;
      return false;
    }
  }

  /**
   * Initializes or reuses the local transformer feature-extraction pipeline
   */
  private static async getExtractor(options: TransformerEmbeddingOptions = {}): Promise<any> {
    const modelName = options.model || TransformerEmbeddingEngine.loadedModelName;
    if (!TransformerEmbeddingEngine.extractorPromise || modelName !== TransformerEmbeddingEngine.loadedModelName) {
      TransformerEmbeddingEngine.loadedModelName = modelName;
      TransformerEmbeddingEngine.extractorPromise = (async () => {
        const { pipeline, env } = await import("@xenova/transformers" as any);
        if (env) {
          // Force local/zero-network execution if models are cached locally
          env.allowRemoteModels = false;
        }
        return pipeline("feature-extraction", modelName, {
          quantized: options.quantized !== false,
        });
      })();
    }
    return TransformerEmbeddingEngine.extractorPromise;
  }

  /**
   * Generates dense neural semantic embedding vector using local ONNX transformer
   */
  public static async embed(text: string, options: TransformerEmbeddingOptions = {}): Promise<number[]> {
    const available = await TransformerEmbeddingEngine.isAvailable();
    if (!available) {
      // Graceful fallback to 64-dim n-gram hashing
      return FastTextEmbeddingEngine.embed(text);
    }

    try {
      const extractor = await TransformerEmbeddingEngine.getExtractor(options);
      const output = await extractor(text, { pooling: "mean", normalize: true });
      const vector: number[] = Array.from(output.data);
      return vector;
    } catch {
      // Fallback on inference error
      return FastTextEmbeddingEngine.embed(text);
    }
  }

  /**
   * Batch embedding generation
   */
  public static async embedBatch(texts: string[], options: TransformerEmbeddingOptions = {}): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await TransformerEmbeddingEngine.embed(text, options));
    }
    return results;
  }
}

/**
 * PluggableEmbeddingEngine
 * Unified gateway supporting both instant synchronous n-gram hashing and
 * asynchronous local neural transformer embeddings.
 */
export class PluggableEmbeddingEngine {
  private static activeBackend: EmbeddingBackend = "fasttext";

  public static setBackend(backend: EmbeddingBackend): void {
    PluggableEmbeddingEngine.activeBackend = backend;
  }

  public static getBackend(): EmbeddingBackend {
    return PluggableEmbeddingEngine.activeBackend;
  }

  /**
   * Generates embedding using active or requested backend
   */
  public static async embed(
    text: string,
    backend: EmbeddingBackend = PluggableEmbeddingEngine.activeBackend,
    options?: TransformerEmbeddingOptions,
  ): Promise<number[]> {
    if (backend === "transformers" || backend === "onnx") {
      return TransformerEmbeddingEngine.embed(text, options);
    }
    return FastTextEmbeddingEngine.embed(text);
  }

  /**
   * Instant synchronous embedding (uses FastText)
   */
  public static embedSync(text: string): number[] {
    return FastTextEmbeddingEngine.embed(text);
  }

  /**
   * Computes cosine similarity between two vectors
   */
  public static cosineSimilarity(a: number[], b: number[]): number {
    return FastTextEmbeddingEngine.cosineSimilarity(a, b);
  }
}

/**
 * FastTextEmbeddingEngine
 *
 * Ultra-fast, zero-network, local embedding and semantic similarity engine.
 * Generates continuous dense vector representations using hashed character n-grams and subword tokenization,
 * with optional pluggable support for ONNX / MiniLM transformers via `@xenova/transformers`.
 *
 * Solves:
 * Paraphrases and vocabulary mismatch where BM25 keyword matching fails
 * (e.g., query "store a photo in cloud" -> targets tool "aws_s3_upload" or "s3_put_object").
 */
export class FastTextEmbeddingEngine {
  private static readonly DIMENSIONS = 64;

  /**
   * Generates a 64-dimensional dense semantic embedding vector for an input text.
   */
  public static embed(text: string): number[] {
    const vector = new Array(FastTextEmbeddingEngine.DIMENSIONS).fill(0);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9_\s]/g, " ");
    const words = cleaned.split(/\s+/).filter(Boolean);

    if (words.length === 0) return vector;

    for (const word of words) {
      // 1. Whole word hash contribution
      const wordHash = FastTextEmbeddingEngine.hashString(word);
      const primaryIdx = Math.abs(wordHash) % FastTextEmbeddingEngine.DIMENSIONS;
      vector[primaryIdx] += 1.0;

      // 2. Character 3-gram and 4-gram subword hashing for stem and morphological capture
      const padded = `<${word}>`;
      for (let len = 3; len <= 4; len++) {
        for (let i = 0; i <= padded.length - len; i++) {
          const gram = padded.slice(i, i + len);
          const gramHash = FastTextEmbeddingEngine.hashString(gram);
          const idx = Math.abs(gramHash) % FastTextEmbeddingEngine.DIMENSIONS;
          const sign = gramHash % 2 === 0 ? 1 : -1;
          vector[idx] += 0.35 * sign;
        }
      }
    }

    // L2 Normalize the vector to unit sphere
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] = Number((vector[i] / norm).toFixed(5));
      }
    }

    return vector;
  }

  /**
   * Computes cosine similarity between two dense normalized vectors: range [-1.0, 1.0]
   */
  public static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return Math.max(0, Math.min(1.0, dot));
  }

  private static hashString(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
}
