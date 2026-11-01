import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SkillDefinition } from "./types.js";

const esmRequire = createRequire(import.meta.url);

/**
 * SkillPrismSqliteStore
 *
 * Lightweight, zero-external-dependency persistence engine powered by Node.js built-in `node:sqlite`.
 * Stores:
 * 1. Registered tools/skills and metadata (`skills` table).
 * 2. Compactor semantic receipts and raw data payloads (`receipts` table).
 *
 * Defaults to `~/.skillprism/index.sqlite` across restarts so OpenAPI specs and indexed MCP tools
 * do not need to be re-parsed or re-fetched every session boot.
 */
export class SkillPrismSqliteStore {
  private db: any = null;
  private dbPath: string;

  constructor(customPath?: string) {
    if (customPath) {
      this.dbPath = customPath;
    } else {
      const homeDir = os.homedir();
      const baseDir = path.join(homeDir, ".skillprism");
      if (!existsSync(baseDir)) {
        try {
          mkdirSync(baseDir, { recursive: true });
        } catch {
          // Fallback to local cwd if homedir not writable
        }
      }
      this.dbPath = path.join(baseDir, "index.sqlite");
    }

    this.initDatabase();
  }

  private initDatabase(): void {
    try {
      const sqliteModule = esmRequire("node:sqlite");
      if (sqliteModule?.DatabaseSync) {
        this.db = new sqliteModule.DatabaseSync(this.dbPath);
        this.migrate();
      }
    } catch {
      // If node:sqlite is not enabled or throws, store degrades gracefully to no-op
      this.db = null;
    }
  }

  private migrate(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        summary TEXT,
        category TEXT,
        token_cost INTEGER,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS receipts (
        ref TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        summary TEXT,
        data_json TEXT NOT NULL,
        raw_bytes INTEGER,
        tokens_saved INTEGER,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
      CREATE INDEX IF NOT EXISTS idx_receipts_expires ON receipts(expires_at);

      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vectors_id ON vectors(id);
    `);
  }

  public isAvailable(): boolean {
    return Boolean(this.db);
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Save a single skill into SQLite
   */
  public saveSkill(skill: SkillDefinition): boolean {
    if (!this.db) return false;
    try {
      const query = this.db.prepare(`
        INSERT INTO skills (id, name, summary, category, token_cost, data_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          summary = excluded.summary,
          category = excluded.category,
          token_cost = excluded.token_cost,
          data_json = excluded.data_json,
          updated_at = excluded.updated_at
      `);
      query.run(
        skill.id,
        skill.name,
        skill.summary,
        skill.category,
        skill.tokenCostEstimate || 250,
        JSON.stringify(skill),
        Date.now(),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save batch of skills in transaction
   */
  public saveSkillsBatch(skills: SkillDefinition[]): number {
    if (!this.db) return 0;
    let saved = 0;
    try {
      this.db.exec("BEGIN TRANSACTION");
      for (const skill of skills) {
        if (this.saveSkill(skill)) saved++;
      }
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure
      }
    }
    return saved;
  }

  /**
   * Load all stored skills from SQLite
   */
  public loadSkills(): SkillDefinition[] {
    if (!this.db) return [];
    try {
      const query = this.db.prepare("SELECT data_json FROM skills ORDER BY updated_at DESC");
      const rows = query.all();
      return rows.map((r: any) => JSON.parse(r.data_json));
    } catch {
      return [];
    }
  }

  /**
   * Save a compactor semantic receipt into SQLite
   */
  public saveReceipt(
    ref: string,
    tool: string,
    summary: string,
    rawData: any,
    rawBytes: number,
    tokensSaved: number,
    expiresAt: number,
  ): boolean {
    if (!this.db) return false;
    try {
      const query = this.db.prepare(`
        INSERT INTO receipts (ref, tool, summary, data_json, raw_bytes, tokens_saved, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ref) DO UPDATE SET
          summary = excluded.summary,
          data_json = excluded.data_json,
          expires_at = excluded.expires_at
      `);
      query.run(
        ref,
        tool,
        summary,
        JSON.stringify(rawData),
        rawBytes,
        tokensSaved,
        expiresAt,
        Date.now(),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load raw payload of a receipt by ref
   */
  public loadReceiptData(ref: string): any | null {
    if (!this.db) return null;
    try {
      const query = this.db.prepare(
        "SELECT data_json, expires_at FROM receipts WHERE ref = ? LIMIT 1",
      );
      const row = query.get(ref);
      if (!row) return null;
      if (row.expires_at < Date.now()) {
        this.deleteReceipt(ref);
        return null;
      }
      return JSON.parse(row.data_json);
    } catch {
      return null;
    }
  }

  /**
   * Delete an expired receipt
   */
  public deleteReceipt(ref: string): void {
    if (!this.db) return;
    try {
      const query = this.db.prepare("DELETE FROM receipts WHERE ref = ?");
      query.run(ref);
    } catch {
      // Ignore deletion failure
    }
  }

  /**
   * Prune all expired receipts
   */
  public pruneExpiredReceipts(): number {
    if (!this.db) return 0;
    try {
      const query = this.db.prepare("DELETE FROM receipts WHERE expires_at < ?");
      const result = query.run(Date.now());
      return Number(result.changes || 0);
    } catch {
      return 0;
    }
  }

  /**
   * Save a dense semantic vector for a skill into SQLite
   */
  public saveVector(id: string, vector: number[]): boolean {
    if (!this.db) return false;
    try {
      const query = this.db.prepare(`
        INSERT INTO vectors (id, dimensions, vector_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          dimensions = excluded.dimensions,
          vector_json = excluded.vector_json,
          updated_at = excluded.updated_at
      `);
      query.run(id, vector.length, JSON.stringify(vector), Date.now());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Batch save vectors in transaction
   */
  public saveVectorsBatch(entries: Array<{ id: string; vector: number[] }>): number {
    if (!this.db) return 0;
    let saved = 0;
    try {
      this.db.exec("BEGIN TRANSACTION");
      for (const entry of entries) {
        if (this.saveVector(entry.id, entry.vector)) saved++;
      }
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure
      }
    }
    return saved;
  }

  /**
   * Load a specific vector by skill ID
   */
  public loadVector(id: string): number[] | null {
    if (!this.db) return null;
    try {
      const query = this.db.prepare("SELECT vector_json FROM vectors WHERE id = ? LIMIT 1");
      const row = query.get(id);
      return row ? JSON.parse(row.vector_json) : null;
    } catch {
      return null;
    }
  }

  /**
   * Load all persistent vectors into in-memory lookup map
   */
  public loadAllVectors(): Map<string, number[]> {
    const map = new Map<string, number[]>();
    if (!this.db) return map;
    try {
      const query = this.db.prepare("SELECT id, vector_json FROM vectors");
      const rows = query.all();
      for (const row of rows) {
        map.set(row.id, JSON.parse(row.vector_json));
      }
    } catch {
      // Ignore
    }
    return map;
  }

  /**
   * Performs nearest-neighbor cosine similarity search over stored vectors
   */
  public searchNearestVectors(
    queryVector: number[],
    topK = 5,
  ): Array<{ id: string; similarity: number }> {
    const all = this.loadAllVectors();
    const scored: Array<{ id: string; similarity: number }> = [];

    for (const [id, vec] of all.entries()) {
      if (vec.length === queryVector.length && vec.length > 0) {
        let dot = 0;
        for (let i = 0; i < vec.length; i++) {
          dot += vec[i] * queryVector[i];
        }
        scored.push({ id, similarity: Math.max(0, Math.min(1.0, dot)) });
      }
    }

    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
  }

  /**
   * Close database handle
   */
  public close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Best effort
      }
      this.db = null;
    }
  }
}

/**
 * Pluggable Vector Index Adapter Interface
 */
export interface VectorIndexAdapter {
  readonly name: string;
  isAvailable(): boolean;
  saveVector(id: string, vector: number[]): boolean;
  saveVectorsBatch(entries: Array<{ id: string; vector: number[] }>): number;
  loadVectors(): Map<string, number[]>;
  searchNearest(
    queryVector: number[],
    topK?: number,
  ): Array<{ id: string; similarity: number }>;
}

/**
 * SqliteVecIndexAdapter
 * Lightweight, zero-dependency SQLite-backed persistent vector index adapter.
 * Enables instant catalog & vector loading across agent restarts with thousands of enterprise tools.
 */
export class SqliteVecIndexAdapter implements VectorIndexAdapter {
  public readonly name = "sqlite-vec";
  private store: SkillPrismSqliteStore;

  constructor(store?: SkillPrismSqliteStore | string) {
    if (typeof store === "string") {
      this.store = new SkillPrismSqliteStore(store);
    } else {
      this.store = store || new SkillPrismSqliteStore();
    }
  }

  public isAvailable(): boolean {
    return this.store.isAvailable();
  }

  public getStore(): SkillPrismSqliteStore {
    return this.store;
  }

  public saveVector(id: string, vector: number[]): boolean {
    return this.store.saveVector(id, vector);
  }

  public saveVectorsBatch(entries: Array<{ id: string; vector: number[] }>): number {
    return this.store.saveVectorsBatch(entries);
  }

  public loadVectors(): Map<string, number[]> {
    return this.store.loadAllVectors();
  }

  public searchNearest(
    queryVector: number[],
    topK = 5,
  ): Array<{ id: string; similarity: number }> {
    return this.store.searchNearestVectors(queryVector, topK);
  }
}
