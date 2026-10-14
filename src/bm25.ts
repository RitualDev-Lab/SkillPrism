/**
 * BM25 Search Engine
 * Implements Okapi BM25 scoring for out-of-context skill ranking.
 * Zero external dependencies, pure sub-millisecond execution.
 */

export class BM25Engine {
  private k1: number;
  private b: number;
  private docLengths: Map<string, number> = new Map();
  private avgDocLength = 0;
  private docFrequencies: Map<string, number> = new Map();
  private docTermFrequencies: Map<string, Map<string, number>> = new Map();
  private totalDocs = 0;

  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  public tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, " ")
      .split(/[\s_\-]+/)
      .filter((term) => term.length > 1);
  }

  public addDocument(docId: string, text: string): void {
    if (this.docTermFrequencies.has(docId)) {
      this.removeDocument(docId);
    }

    const terms = this.tokenize(text);
    const termCounts = new Map<string, number>();

    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }

    this.docTermFrequencies.set(docId, termCounts);
    this.docLengths.set(docId, terms.length);
    this.totalDocs++;

    // Track document frequency for each unique term
    for (const term of termCounts.keys()) {
      this.docFrequencies.set(term, (this.docFrequencies.get(term) || 0) + 1);
    }

    // Recalculate average document length
    let sumLength = 0;
    for (const len of this.docLengths.values()) {
      sumLength += len;
    }
    this.avgDocLength = this.totalDocs > 0 ? sumLength / this.totalDocs : 0;
  }

  public removeDocument(docId: string): void {
    const existingTerms = this.docTermFrequencies.get(docId);
    if (!existingTerms) return;

    for (const term of existingTerms.keys()) {
      const currentFreq = this.docFrequencies.get(term) || 1;
      if (currentFreq <= 1) {
        this.docFrequencies.delete(term);
      } else {
        this.docFrequencies.set(term, currentFreq - 1);
      }
    }

    this.docTermFrequencies.delete(docId);
    this.docLengths.delete(docId);
    this.totalDocs = Math.max(0, this.totalDocs - 1);

    let sumLength = 0;
    for (const len of this.docLengths.values()) {
      sumLength += len;
    }
    this.avgDocLength = this.totalDocs > 0 ? sumLength / this.totalDocs : 0;
  }

  public search(query: string): Map<string, number> {
    const queryTerms = this.tokenize(query);
    const scores = new Map<string, number>();

    if (this.totalDocs === 0 || queryTerms.length === 0) {
      return scores;
    }

    for (const term of queryTerms) {
      const docFreq = this.docFrequencies.get(term) || 0;
      if (docFreq === 0) continue;

      // Inverse Document Frequency (IDF) with smoothing
      const idf = Math.log(1 + (this.totalDocs - docFreq + 0.5) / (docFreq + 0.5));

      for (const [docId, termCounts] of this.docTermFrequencies.entries()) {
        const tf = termCounts.get(term);
        if (!tf || tf <= 0) continue;

        const docLen = this.docLengths.get(docId) || this.avgDocLength;
        const denominator =
          tf + this.k1 * (1 - this.b + this.b * (docLen / (this.avgDocLength || 1)));
        const termScore = idf * ((tf * (this.k1 + 1)) / denominator);
        if (termScore > 0) {
          scores.set(docId, (scores.get(docId) || 0) + termScore);
        }
      }
    }

    return scores;
  }

  public getTotalTerms(): number {
    return this.docFrequencies.size;
  }
}
