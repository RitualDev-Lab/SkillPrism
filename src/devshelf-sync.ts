import type { SkillIndex } from "./index-store.js";

export interface DevShelfRawItem {
  name: string;
  url: string;
  description: string;
  category?: string;
  tags?: string[];
  pricing?: string;
}

export interface DevShelfSyncResult {
  totalSynced: number;
  categories: Record<string, number>;
  sourceUrl: string;
  isFallback: boolean;
  etag?: string;
  isCached304?: boolean;
  categorySkillsCreated?: number;
}

/**
 * DevShelfSync
 * Dogfoods the 520+ verified tools catalog from DevShelf into SkillPrism's
 * out-of-context registry with ETag caching, background revalidation,
 * and category-level skill indexing.
 */
export class DevShelfSync {
  private static readonly CANONICAL_API_URL = "https://devshelf.ritualdev.in/api/v1/tools.json";
  private static lastEtag?: string;
  private static cachedCatalog: DevShelfRawItem[] = [];

  public static getLastEtag(): string | undefined {
    return DevShelfSync.lastEtag;
  }

  public static setLastEtag(etag: string | undefined): void {
    DevShelfSync.lastEtag = etag;
  }

  public static clearCache(): void {
    DevShelfSync.lastEtag = undefined;
    DevShelfSync.cachedCatalog = [];
  }

  /**
   * Starts background revalidation loop that periodically checks DevShelf API for updates
   */
  public static startBackgroundRevalidation(
    index: SkillIndex,
    intervalMs = 300000,
    onUpdate?: (res: DevShelfSyncResult) => void,
  ): () => void {
    const timer = setInterval(async () => {
      try {
        const res = await DevShelfSync.syncToCatalog(index);
        if (onUpdate) onUpdate(res);
      } catch {
        // Background revalidation failure is non-fatal
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }

  /**
   * Syncs tools directly from DevShelf's live catalog API with ETag caching and category indexing
   */
  public static async syncToCatalog(
    index: SkillIndex,
    customFetch?: (url: string, init?: RequestInit) => Promise<any>,
  ): Promise<DevShelfSyncResult> {
    const categories: Record<string, number> = {};
    const itemsByCategory: Record<string, DevShelfRawItem[]> = {};
    let items: DevShelfRawItem[] = [];
    let isFallback = false;
    let isCached304 = false;
    let responseEtag = DevShelfSync.lastEtag;

    try {
      if (customFetch) {
        const customRes = await customFetch(DevShelfSync.CANONICAL_API_URL, {
          headers: DevShelfSync.lastEtag ? { "If-None-Match": DevShelfSync.lastEtag } : {},
        });
        if (customRes && typeof customRes === "object" && customRes.status === 304) {
          isCached304 = true;
          items = DevShelfSync.cachedCatalog;
        } else if (Array.isArray(customRes)) {
          items = customRes;
          DevShelfSync.cachedCatalog = items;
        } else if (customRes?.items && Array.isArray(customRes.items)) {
          items = customRes.items;
          DevShelfSync.cachedCatalog = items;
        } else {
          items = DevShelfSync.getFallbackSeedCatalog();
          isFallback = true;
        }
      } else {
        const headers: Record<string, string> = {};
        if (DevShelfSync.lastEtag) {
          headers["If-None-Match"] = DevShelfSync.lastEtag;
        }

        const res = await fetch(DevShelfSync.CANONICAL_API_URL, { headers });
        if (res.status === 304 && DevShelfSync.cachedCatalog.length > 0) {
          isCached304 = true;
          items = DevShelfSync.cachedCatalog;
        } else if (res.ok) {
          const etagHeader = res.headers.get("etag");
          if (etagHeader) {
            responseEtag = etagHeader;
            DevShelfSync.lastEtag = etagHeader;
          }
          items = (await res.json()) as DevShelfRawItem[];
          DevShelfSync.cachedCatalog = items;
        } else {
          isFallback = true;
          items = DevShelfSync.getFallbackSeedCatalog();
        }
      }
    } catch {
      isFallback = true;
      items = DevShelfSync.getFallbackSeedCatalog();
    }

    if (!Array.isArray(items) || items.length === 0) {
      isFallback = true;
      items = DevShelfSync.getFallbackSeedCatalog();
    }

    let count = 0;
    const seenIds = new Set<string>();

    for (const item of items) {
      const baseSlug = item.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 50);
      let slug = baseSlug || "tool";
      let counter = 1;
      while (seenIds.has(slug)) {
        slug = `${baseSlug}_${counter++}`;
      }
      seenIds.add(slug);

      const cat = (item.category?.toLowerCase() || "general") as any;

      index.register({
        id: `devshelf_${slug}`,
        name: item.name,
        summary: item.description?.slice(0, 110) || `Developer tool: ${item.name}`,
        description: `${item.description} (URL: ${item.url})`,
        category: cat,
        tags: [...(item.tags || []), slug, "devshelf"],
        parameters: [
          { name: "action", type: "string", description: "Operation to execute" },
          { name: "query", type: "string", description: "Search query or input parameter" },
        ],
        sourceServer: "devshelf.ritualdev.in",
      });

      categories[cat] = (categories[cat] || 0) + 1;
      if (!itemsByCategory[cat]) itemsByCategory[cat] = [];
      itemsByCategory[cat].push(item);
      count++;
    }

    // Category-Level Skill Indexing: register composite category discovery skills
    let categorySkillsCount = 0;
    for (const [catName, catItems] of Object.entries(itemsByCategory)) {
      const catSlug = catName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const sampleNames = catItems.slice(0, 5).map((i) => i.name).join(", ");
      const allTags = Array.from(new Set(catItems.flatMap((i) => i.tags || []))).slice(0, 12);

      index.register({
        id: `devshelf_category_${catSlug}`,
        name: `${catName.toUpperCase()} Tools Category`,
        summary: `Curated directory of ${catItems.length} verified ${catName} developer tools (${sampleNames})`,
        description: `High-level category skill for ${catName}. Tools include: ${catItems.map((i) => i.name).join(", ")}. URL: ${DevShelfSync.CANONICAL_API_URL}`,
        category: (catName as any) || "general",
        tags: [catSlug, "category-catalog", "devshelf-category", ...allTags],
        parameters: [
          { name: "filter", type: "string", description: `Filter tools inside ${catName} domain` },
          { name: "limit", type: "number", description: "Maximum candidate tools to return" },
        ],
        sourceServer: "devshelf.ritualdev.in",
      });
      categorySkillsCount++;
    }

    return {
      totalSynced: count,
      categories,
      sourceUrl: DevShelfSync.CANONICAL_API_URL,
      isFallback,
      etag: responseEtag,
      isCached304,
      categorySkillsCreated: categorySkillsCount,
    };
  }

  private static getFallbackSeedCatalog(): DevShelfRawItem[] {
    return [
      {
        name: "Supabase",
        url: "https://supabase.com",
        description:
          "Open source Firebase alternative with Postgres database, Authentication, instant APIs, and Realtime.",
        category: "database",
        tags: ["postgres", "auth", "api", "backend"],
      },
      {
        name: "Postman",
        url: "https://postman.com",
        description: "API platform for building and using APIs with automated testing and mocking.",
        category: "api",
        tags: ["api", "testing", "rest", "mocking"],
      },
      {
        name: "Fly.io",
        url: "https://fly.io",
        description: "Deploy app servers close to your users globally with lightweight microVMs.",
        category: "cloud",
        tags: ["cloud", "hosting", "docker", "compute"],
      },
      {
        name: "AgentShield",
        url: "https://agentshield.ritualdev.in",
        description: "Zero-Leak secret defense & sandbox for autonomous AI coding agents.",
        category: "security",
        tags: ["security", "secrets", "zero-leak", "claude-code"],
      },
      {
        name: "Hugging Face",
        url: "https://huggingface.co",
        description: "Platform for AI models, datasets, and serverless inference APIs.",
        category: "ai",
        tags: ["ai", "models", "llm", "inference"],
      },
    ];
  }
}
