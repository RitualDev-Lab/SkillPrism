/**
 * Bidirectional Tool-Call Taint Tracking & Indirect Prompt Injection Blocker.
 * Inspects both agent-to-tool arguments and tool-to-agent responses for malicious
 * instruction overrides, data exfiltration channels, and prompt injection payloads.
 */

export interface TaintViolation {
  code: string;
  category:
    | "INDIRECT_INJECTION"
    | "EXFILTRATION_ATTEMPT"
    | "COMMAND_INJECTION"
    | "DELIMITER_TAMPERING";
  message: string;
  pattern: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
}

export interface TaintScanResult {
  safe: boolean;
  violations: TaintViolation[];
  sanitizedText: string;
  originalText: string;
}

export class ToolCallTaintTracker {
  private static readonly INJECTION_PATTERNS = [
    {
      code: "INDIRECT_INJECTION_OVERRIDE",
      category: "INDIRECT_INJECTION" as const,
      regex:
        /(ignore\s+all\s+previous\s+instructions|disregard\s+previous\s+(instructions|directives)|new\s+system\s+instruction|system\s+prompt\s+override)/i,
      message: "Detected indirect prompt injection overriding prior instructions.",
      severity: "CRITICAL" as const,
    },
    {
      code: "ROLE_DELIMITER_SPOOFING",
      category: "DELIMITER_TAMPERING" as const,
      regex:
        /(<\s*system\s*>|<\s*\/system\s*>|\[\s*SYSTEM\s*\]|\n\s*SYSTEM:\s+|\n\s*ASSISTANT:\s+|<\|im_start\|>|<\|im_end\|>)/i,
      message: "Detected model role delimiter injection / chat template spoofing.",
      severity: "CRITICAL" as const,
    },
    {
      code: "MARKDOWN_EXFILTRATION",
      category: "EXFILTRATION_ATTEMPT" as const,
      regex:
        /(!\[.*?\]\s*\(\s*https?:\/\/[^\s)]+\?[^\s)]*(token|key|secret|password|auth|creds)=)/i,
      message: "Detected markdown image/link token exfiltration channel.",
      severity: "CRITICAL" as const,
    },
    {
      code: "INVISIBLE_UNICODE_PAYLOAD",
      category: "INDIRECT_INJECTION" as const,
      regex: /(\u200B|\u200C|\u200D|\uFEFF){3,}/,
      message: "Detected hidden zero-width or Unicode tag prompt injection payload.",
      severity: "HIGH" as const,
    },
    {
      code: "SHELL_EXECUTION_ESCAPE",
      category: "COMMAND_INJECTION" as const,
      regex:
        /(;\s*(rm\s+-rf|curl\s+.*?\|\s*sh|wget\s+.*?\|\s*bash|cat\s+~\/\.ssh|cat\s+~\/\.aws))/i,
      message: "Detected high-risk system shell execution escape payload.",
      severity: "CRITICAL" as const,
    },
  ];

  /**
   * Scans a text string (from an external API response or tool argument) for prompt injections
   */
  public static scan(input: string): TaintScanResult {
    const violations: TaintViolation[] = [];
    let sanitizedText = input;

    for (const pat of ToolCallTaintTracker.INJECTION_PATTERNS) {
      if (pat.regex.test(input)) {
        violations.push({
          code: pat.code,
          category: pat.category,
          message: pat.message,
          pattern: pat.regex.source,
          severity: pat.severity,
        });

        // Redact detected payload in sanitized output
        sanitizedText = sanitizedText.replace(pat.regex, "[BLOCKED_INDIRECT_PROMPT_INJECTION]");
      }
    }

    return {
      safe: violations.length === 0,
      violations,
      sanitizedText,
      originalText: input,
    };
  }

  /**
   * Scans an arbitrary JSON value (e.g. tool arguments or tool response object) recursively
   */
  public static scanValue(val: unknown): {
    safe: boolean;
    violations: TaintViolation[];
    sanitized: unknown;
  } {
    if (typeof val === "string") {
      const res = ToolCallTaintTracker.scan(val);
      return {
        safe: res.safe,
        violations: res.violations,
        sanitized: res.sanitizedText,
      };
    }

    if (Array.isArray(val)) {
      const allViolations: TaintViolation[] = [];
      let isSafe = true;
      const sanitizedArray = val.map((item) => {
        const itemRes = ToolCallTaintTracker.scanValue(item);
        if (!itemRes.safe) {
          isSafe = false;
          allViolations.push(...itemRes.violations);
        }
        return itemRes.sanitized;
      });
      return { safe: isSafe, violations: allViolations, sanitized: sanitizedArray };
    }

    if (val !== null && typeof val === "object") {
      const allViolations: TaintViolation[] = [];
      let isSafe = true;
      const sanitizedObj: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const res = ToolCallTaintTracker.scanValue(v);
        if (!res.safe) {
          isSafe = false;
          allViolations.push(...res.violations);
        }
        sanitizedObj[k] = res.sanitized;
      }

      return { safe: isSafe, violations: allViolations, sanitized: sanitizedObj };
    }

    return { safe: true, violations: [], sanitized: val };
  }
}
