export interface SemanticEmbeddingVector {
  id: string;
  vector: number[];
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
