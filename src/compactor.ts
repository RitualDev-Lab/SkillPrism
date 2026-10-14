import { createHash } from "node:crypto";

export interface SemanticReceipt {
  /** Unique reference token: e.g. "receipt:4a7f9b8c" */
  ref: string;
  /** Executed tool or skill identifier */
  tool: string;
  /** Compact 1-line semantic execution summary */
  summary: string;
  /** Essential scalar fields extracted directly for fast model reasoning */
  keyFields: Record<string, any>;
  /** Execution status */
  status: "success" | "error";
  /** Original raw byte count before compaction */
  rawBytes: number;
  /** Estimated tokens saved by substituting receipt for raw data */
  tokensSaved: number;
  /** ISO timestamp */
  timestamp: string;
}

export interface CompactorStats {
  totalReceipts: number;
  totalRawBytesCompacted: number;
  totalTokensSaved: number;
  activeCacheEntries: number;
}

/**
 * ContextCompactor & Semantic Receipt Garbage Collector (GC)
 *
 * The Problem:
 * When tools return massive payloads (e.g. 500 DB rows, 200 S3 keys, or full API responses),
 * raw dumps blow past context windows and trigger token drift across multi-turn reasoning.
 *
 * The Solution:
 * 1. Compacts heavy payloads into lightweight semantic receipts (< 120 tokens).
 * 2. Caches full raw data out-of-context in memory/vault.
 * 3. Provides an `inspect_receipt` query helper for the model to fetch specific fields on demand.
 */
export class ContextCompactor {
  private vault: Map<string, { data: any; createdAt: number; expiresAt: number }> = new Map();
  private maxByteThreshold: number;
  private defaultTtlMs: number;
  private maxVaultEntries: number;
  private totalRawBytesCompacted = 0;
  private totalTokensSaved = 0;

  constructor(maxByteThreshold = 512, defaultTtlMs = 1000 * 60 * 30, maxVaultEntries = 500) {
    this.maxByteThreshold = maxByteThreshold;
    this.defaultTtlMs = defaultTtlMs;
    this.maxVaultEntries = maxVaultEntries;
  }

  /**
   * Safely stringifies arbitrary input without throwing on circular refs or undefined
   */
  private safeStringify(data: any): string {
    if (data === undefined) return "undefined";
    if (data === null) return "null";
    if (typeof data === "string") return data;
    try {
      const seen = new WeakSet();
      return JSON.stringify(data, (_key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular Reference]";
          seen.add(value);
        }
        return value;
      });
    } catch {
      return String(data);
    }
  }

  /**
   * Compacts raw execution output if it exceeds maxByteThreshold
   */
  public compact(
    toolName: string,
    rawData: any,
    ttlMs?: number
  ): { isCompacted: boolean; output: any; receipt?: SemanticReceipt } {
    // Opportunistic automatic GC to keep memory bounded
    this.gc();

    const rawString = this.safeStringify(rawData);
    const byteSize = Buffer.byteLength(rawString, "utf8");

    // If small enough, no compaction needed
    if (byteSize <= this.maxByteThreshold) {
      return { isCompacted: false, output: rawData };
    }

    // Evict oldest entry if vault capacity reached
    if (this.vault.size >= this.maxVaultEntries) {
      const oldestKey = this.vault.keys().next().value;
      if (oldestKey) this.vault.delete(oldestKey);
    }

    // Generate cryptographic hash reference
    const hash = createHash("sha256").update(rawString).digest("hex").slice(0, 12);
    const ref = `receipt:${toolName}:${hash}`;

    // Store raw object out-of-context in vault with expiry
    const now = Date.now();
    const expiry = now + (ttlMs || this.defaultTtlMs);
    this.vault.set(ref, { data: rawData, createdAt: now, expiresAt: expiry });

    // Extract high-value summary and scalar fields
    const { summary, keyFields } = this.extractSemanticSummary(toolName, rawData);

    const receiptString = JSON.stringify({ ref, summary, keyFields });
    const receiptByteSize = Buffer.byteLength(receiptString, "utf8");
    const estimatedRawTokens = Math.ceil(byteSize / 3.8);
    const estimatedReceiptTokens = Math.ceil(receiptByteSize / 3.8);
    const tokensSaved = Math.max(0, estimatedRawTokens - estimatedReceiptTokens);

    this.totalRawBytesCompacted += byteSize;
    this.totalTokensSaved += tokensSaved;

    const receipt: SemanticReceipt = {
      ref,
      tool: toolName,
      summary,
      keyFields,
      status: "success",
      rawBytes: byteSize,
      tokensSaved,
      timestamp: new Date().toISOString(),
    };

    return {
      isCompacted: true,
      output: receipt,
      receipt,
    };
  }

  /**
   * Model tool to inspect or drill down into specific keys of a compacted receipt
   */
  public inspectReceipt(ref: string, path?: string): { success: boolean; data?: any; error?: string } {
    const entry = this.vault.get(ref);
    if (!entry) {
      return {
        success: false,
        error: `Receipt '${ref}' was not found in the compaction vault or has expired.`,
      };
    }

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      this.vault.delete(ref);
      return {
        success: false,
        error: `Receipt '${ref}' has expired and was purged from out-of-context storage.`,
      };
    }

    const fullData = entry.data;

    if (!path) {
      return { success: true, data: fullData };
    }

    // Simple dot/bracket path resolution: e.g. "users.0.email"
    try {
      const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
      let current = fullData;
      for (const key of keys) {
        if (current === undefined || current === null) break;
        current = current[key];
      }
      return { success: true, data: current };
    } catch (err: any) {
      return { success: false, error: `Failed to resolve path '${path}': ${err.message}` };
    }
  }

  /**
   * Purge old or expired receipts from out-of-context memory (Garbage Collection)
   */
  public gc(olderThanMs?: number): number {
    const now = Date.now();
    let purged = 0;

    for (const [ref, entry] of this.vault.entries()) {
      if (now > entry.expiresAt || (olderThanMs && now - entry.createdAt > olderThanMs)) {
        this.vault.delete(ref);
        purged++;
      }
    }

    return purged;
  }

  /**
   * Get telemetry and efficiency statistics
   */
  public getStats(): CompactorStats {
    return {
      totalReceipts: this.vault.size,
      totalRawBytesCompacted: this.totalRawBytesCompacted,
      totalTokensSaved: this.totalTokensSaved,
      activeCacheEntries: this.vault.size,
    };
  }

  private extractSemanticSummary(
    toolName: string,
    rawData: any
  ): { summary: string; keyFields: Record<string, any> } {
    const keyFields: Record<string, any> = {};

    if (Array.isArray(rawData)) {
      const length = rawData.length;
      if (length > 0 && typeof rawData[0] === "object" && rawData[0] !== null) {
        keyFields.sampleKeys = Object.keys(rawData[0]).slice(0, 5);
        keyFields.firstItemSnippet = rawData[0];
      }
      return {
        summary: `Retrieved array of ${length} records from ${toolName}`,
        keyFields: {
          count: length,
          ...keyFields,
        },
      };
    }

    if (typeof rawData === "object" && rawData !== null) {
      const keys = Object.keys(rawData);
      for (const k of keys.slice(0, 4)) {
        const val = rawData[k];
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
          keyFields[k] = val;
        }
      }

      if (rawData.id) keyFields.id = rawData.id;
      if (rawData.status) keyFields.status = rawData.status;
      if (rawData.count !== undefined) keyFields.count = rawData.count;

      return {
        summary: `Payload returned ${keys.length} top-level fields for ${toolName}`,
        keyFields,
      };
    }

    return {
      summary: `Large text output returned from ${toolName}`,
      keyFields: { preview: String(rawData).slice(0, 100) },
    };
  }
}
