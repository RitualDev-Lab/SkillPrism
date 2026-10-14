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
}

/**
 * DevShelfSync
 * Dogfoods the 520+ verified tools catalog from DevShelf into SkillPrism's
 * out-of-context registry.
 */
export class DevShelfSync {
  private static readonly CANONICAL_API_URL = "https://devshelf.ritualdev.in/api/v1/tools.json";

  /**
   * Syncs tools directly from DevShelf's live catalog API or local fallback
   */
  public static async syncToCatalog(
    index: SkillIndex,
    customFetch?: (url: string) => Promise<any>,
  ): Promise<DevShelfSyncResult> {
    const categories: Record<string, number> = {};
    let items: DevShelfRawItem[] = [];
    let isFallback = false;

    try {
      if (customFetch) {
        items = await customFetch(DevShelfSync.CANONICAL_API_URL);
      } else {
        const res = await fetch(DevShelfSync.CANONICAL_API_URL);
        if (res.ok) {
          items = (await res.json()) as DevShelfRawItem[];
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
      count++;
    }

    return {
      totalSynced: count,
      categories,
      sourceUrl: DevShelfSync.CANONICAL_API_URL,
      isFallback,
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
