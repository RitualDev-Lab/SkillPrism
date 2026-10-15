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
