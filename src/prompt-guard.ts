import type { MetaToolDefinition } from "./harness.js";
import type { SkillDefinition } from "./types.js";

export interface PromptSanitizationResult {
  sanitized: string;
  wasModified: boolean;
  detections: string[];
}

const INVISIBLE_UNICODE_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

const PROMPT_INJECTION_RULES: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "instruction-override",
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|rules?|prompts?|policies?)\b[^\n]*/gi,
  },
  {
    id: "role-hijack",
    pattern:
      /\b(?:you\s+are\s+now\s+(?:a|an|in)\s+(?:unrestricted|developer|jailbroken|root|dan)|act\s+as\s+system\s+administrator)\b[^\n]*/gi,
  },
  {
    id: "delimiter-smuggling",
    pattern: /<\|(?:im_start|im_end|system|endoftext)\|>\s*[^<\n]*/gi,
  },
  {
    id: "hidden-system-tag",
    pattern:
      /<\/?(?:system|instructions|hidden_prompt|tool_override)[^>]*>[\s\S]*?(?:<\/(?:system|instructions|hidden_prompt|tool_override)>|$)/gi,
  },
  {
    id: "exfiltration-directive",
    pattern:
      /\b(?:run|execute|invoke)\s+(?:curl|wget|bash|sh|powershell|nc)\b[^\n]*(?:http|env|ssh|passwd|secret|token|evil|id_rsa)[^\n]*/gi,
  },
  {
    id: "secret-exfil-directive",
    pattern:
      /\b(?:exfiltrate|steal|leak|send|post|upload)\s+(?:all\s+)?(?:\.env|api\s*keys?|credentials?|secrets?|ssh\s*keys?|tokens?)\b[^\n]*/gi,
  },
];

/**
 * Sanitizes untrusted third-party MCP tool descriptions and schema metadata
 * to neutralize indirect prompt-injection & tool-poisoning attacks before
 * injecting schemas into the host LLM context window.
 */
export function sanitizeMcpSchemaText(input: string): PromptSanitizationResult {
  if (!input) {
    return { sanitized: "", wasModified: false, detections: [] };
  }

  const detections: string[] = [];
  let text = input;

  if (INVISIBLE_UNICODE_REGEX.test(text)) {
    detections.push("invisible-unicode-smuggling");
    text = text.replace(INVISIBLE_UNICODE_REGEX, "");
  }

  for (const rule of PROMPT_INJECTION_RULES) {
    const rx = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (rx.test(text)) {
      detections.push(rule.id);
      text = text.replace(
        new RegExp(rule.pattern.source, rule.pattern.flags),
        "[SKILLPRISM_SANITIZED_INJECTION]",
      );
    }
  }

  return {
    sanitized: text.replace(/\s{2,}/g, " ").trim(),
    wasModified: detections.length > 0,
    detections,
  };
}

function sanitizeJsonSchemaNode(node: unknown, detections: string[]): unknown {
  if (typeof node === "string") {
    const res = sanitizeMcpSchemaText(node);
    if (res.wasModified) detections.push(...res.detections);
    return res.sanitized;
  }
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeJsonSchemaNode(item, detections));
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "description" || k === "title" || k === "summary") {
        out[k] = sanitizeJsonSchemaNode(v, detections);
      } else if (typeof v === "object" && v !== null) {
        out[k] = sanitizeJsonSchemaNode(v, detections);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return node;
}

export function sanitizeToolDefinition(tool: MetaToolDefinition): {
  tool: MetaToolDefinition;
  detections: string[];
} {
  const detections: string[] = [];
  const descRes = sanitizeMcpSchemaText(tool.description || "");
  if (descRes.wasModified) detections.push(...descRes.detections);

  const sanitizedParams = sanitizeJsonSchemaNode(
    tool.parameters,
    detections,
  ) as MetaToolDefinition["parameters"];

  return {
    tool: {
      ...tool,
      description: descRes.sanitized,
      parameters: sanitizedParams,
    },
    detections: [...new Set(detections)],
  };
}

export function sanitizeSkillSummary(skill: SkillDefinition): string {
  return sanitizeMcpSchemaText(skill.summary || skill.description || "").sanitized;
}
