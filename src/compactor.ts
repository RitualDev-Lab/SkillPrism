import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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
  private storageDir?: string;
  private totalRawBytesCompacted = 0;
  private totalTokensSaved = 0;

  constructor(
    maxByteThreshold = 512,
    defaultTtlMs = 1000 * 60 * 30,
    maxVaultEntries = 500,
    storageDir?: string,
  ) {
    this.maxByteThreshold = maxByteThreshold;
    this.defaultTtlMs = defaultTtlMs;
    this.maxVaultEntries = maxVaultEntries;
    this.storageDir = storageDir;
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

  public getMaxByteThreshold(): number {
    return this.maxByteThreshold;
  }

  public setMaxByteThreshold(threshold: number): void {
    this.maxByteThreshold = threshold;
  }

  /**
   * Compacts raw execution output if it exceeds maxByteThreshold
   */
  public compact(
    toolName: string,
    rawData: any,
    ttlMs?: number,
    status: "success" | "error" = "success",
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
      if (oldestKey) {
        this.vault.delete(oldestKey);
        if (this.storageDir) {
          try {
            const safeFilename = `${oldestKey.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`;
            const filePath = path.join(this.storageDir, safeFilename);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          } catch {
            // Best effort disk cleanup
          }
        }
      }
    }

    // Generate cryptographic hash reference
    const hash = createHash("sha256").update(rawString).digest("hex").slice(0, 12);
    const ref = `receipt:${toolName}:${hash}`;

    // Store raw object out-of-context in vault with expiry
    const now = Date.now();
    const expiry = now + (ttlMs || this.defaultTtlMs);
    this.vault.set(ref, { data: rawData, createdAt: now, expiresAt: expiry });

    // Optional disk backup
    if (this.storageDir) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
        const safeFilename = `${ref.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`;
        fs.writeFileSync(
          path.join(this.storageDir, safeFilename),
          JSON.stringify({ ref, data: rawData, expiresAt: expiry }),
          "utf8",
        );
      } catch {
        // Disk write is best-effort fallback
      }
    }

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
      status,
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
   * Compacts an MCP CallToolResult or array of content blocks, preserving
   * multimodal elements (images, resources) and error flags while compacting
   * oversized text blocks into semantic receipts.
   */
  public compactMcpResult(
    toolName: string,
    rawResult: { content?: any[]; isError?: boolean; [key: string]: any },
    ttlMs?: number,
  ): {
    isCompacted: boolean;
    result: { content: any[]; isError?: boolean; [key: string]: any };
    receipts: SemanticReceipt[];
  } {
    if (!rawResult || typeof rawResult !== "object" || !Array.isArray(rawResult.content)) {
      return {
        isCompacted: false,
        result: { content: rawResult?.content || [], isError: rawResult?.isError },
        receipts: [],
      };
    }

    const receipts: SemanticReceipt[] = [];
    let isCompacted = false;
    const status: "success" | "error" = rawResult.isError ? "error" : "success";

    const compactedContent = rawResult.content.map((block) => {
      // Preserve non-text blocks (image, resource, etc.) without modification
      if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
        return block;
      }

      const byteSize = Buffer.byteLength(block.text, "utf8");
      if (byteSize <= this.maxByteThreshold) {
        return block;
      }

      // Payload exceeds threshold: determine if it's JSON structured or plain text
      let payloadToCompact: any = block.text;
      try {
        const parsed = JSON.parse(block.text);
        if (parsed !== null && typeof parsed === "object") {
          payloadToCompact = parsed;
        }
      } catch {
        // Keep as string
      }

      const compacted = this.compact(toolName, payloadToCompact, ttlMs, status);
      if (compacted.isCompacted && compacted.receipt) {
        isCompacted = true;
        receipts.push(compacted.receipt);
        return {
          type: "text",
          text: JSON.stringify(compacted.receipt, null, 2),
        };
      }

      return block;
    });

    return {
      isCompacted,
      result: {
        ...rawResult,
        content: compactedContent,
        ...(rawResult.isError !== undefined ? { isError: rawResult.isError } : {}),
      },
      receipts,
    };
  }

  /**
   * Model tool to inspect or drill down into specific keys of a compacted receipt
   */
  public inspectReceipt(
    ref: string,
    queryPath?: string,
  ): { success: boolean; data?: any; error?: string } {
    let entry = this.vault.get(ref);
    if (!entry && this.storageDir) {
      try {
        const safeFilename = `${ref.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`;
        const filePath = path.join(this.storageDir, safeFilename);
        if (fs.existsSync(filePath)) {
          const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
          if (Date.now() <= raw.expiresAt) {
            entry = { data: raw.data, createdAt: Date.now(), expiresAt: raw.expiresAt };
            this.vault.set(ref, entry);
          }
        }
      } catch {
        // Disk read error
      }
    }

    if (!entry) {
      return {
        success: false,
        error: `Receipt '${ref}' was not found in the compaction vault or has expired.`,
      };
    }

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      this.vault.delete(ref);
      if (this.storageDir) {
        try {
          const safeFilename = `${ref.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`;
          const filePath = path.join(this.storageDir, safeFilename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // Disk cleanup is best effort
        }
      }
      return {
        success: false,
        error: `Receipt '${ref}' has expired and was purged from out-of-context storage.`,
      };
    }

    const fullData = entry.data;

    if (!queryPath) {
      return { success: true, data: fullData };
    }

    // If fullData is a string, support targeted line/slice or preview queries
    if (typeof fullData === "string") {
      if (queryPath === "preview") {
        return { success: true, data: fullData.slice(0, 500) };
      }
      if (queryPath.startsWith("lines:")) {
        const parts = queryPath.slice(6).split("-");
        const start = Math.max(1, Number.parseInt(parts[0], 10) || 1);
        const end = Math.max(start, Number.parseInt(parts[1], 10) || start);
        const lines = fullData.split(/\r?\n/);
        return { success: true, data: lines.slice(start - 1, end).join("\n") };
      }
      if (queryPath.startsWith("slice:")) {
        const parts = queryPath.slice(6).split(":");
        const start = Number.parseInt(parts[0], 10) || 0;
        const end = Number.parseInt(parts[1], 10) || fullData.length;
        return { success: true, data: fullData.slice(start, end) };
      }
      // If string happens to be serialized JSON, attempt object path extraction
      try {
        const parsed = JSON.parse(fullData);
        if (parsed && typeof parsed === "object") {
          return this.resolveObjectPath(parsed, queryPath);
        }
      } catch {
        // Fall through
      }
      return { success: true, data: fullData };
    }

    return this.resolveObjectPath(fullData, queryPath);
  }

  private resolveObjectPath(
    obj: any,
    queryPath: string,
  ): { success: boolean; data?: any; error?: string } {
    try {
      const keys = queryPath
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .filter(Boolean);
      let current = obj;
      for (const key of keys) {
        if (current === undefined || current === null) break;
        current = current[key];
      }
      return { success: true, data: current };
    } catch (err: any) {
      return { success: false, error: `Failed to resolve path '${queryPath}': ${err.message}` };
    }
  }

  /**
   * Purge old or expired receipts from out-of-context memory and disk storage (Garbage Collection)
   */
  public gc(olderThanMs?: number): number {
    const now = Date.now();
    let purged = 0;

    for (const [ref, entry] of this.vault.entries()) {
      if (now > entry.expiresAt || (olderThanMs && now - entry.createdAt > olderThanMs)) {
        this.vault.delete(ref);
        if (this.storageDir) {
          try {
            const safeFilename = `${ref.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`;
            const filePath = path.join(this.storageDir, safeFilename);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          } catch {
            // Disk cleanup is best effort
          }
        }
        purged++;
      }
    }

    // Clean up expired or aged-out files from disk storage if configured
    if (this.storageDir && fs.existsSync(this.storageDir)) {
      try {
        const files = fs.readdirSync(this.storageDir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const filePath = path.join(this.storageDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (olderThanMs && now - stat.mtimeMs > olderThanMs) {
              fs.unlinkSync(filePath);
              purged++;
              continue;
            }
            const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (raw.expiresAt && now > raw.expiresAt) {
              fs.unlinkSync(filePath);
              purged++;
            }
          } catch {
            // Corrupt or unreadable disk file, prune it
            try {
              fs.unlinkSync(filePath);
              purged++;
            } catch {
              // Ignore
            }
          }
        }
      } catch {
        // Disk cleanup is best effort
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
    rawData: any,
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

    if (typeof rawData === "string") {
      const lines = rawData.split(/\r?\n/);
      const lineCount = lines.length;
      const charCount = rawData.length;
      const preview = rawData.slice(0, 200).trim();
      return {
        summary: `Large text output (${lineCount} lines, ${charCount} chars) returned from ${toolName}`,
        keyFields: {
          lines: lineCount,
          characters: charCount,
          preview: preview.length > 0 ? preview : "[Empty text]",
        },
      };
    }

    return {
      summary: `Large text output returned from ${toolName}`,
      keyFields: { preview: String(rawData).slice(0, 100) },
    };
  }
}
