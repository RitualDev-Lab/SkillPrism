# 💎 SkillPrism

> **Progressive Skill Disclosure & Context Compaction Engine for Autonomous AI Coding Agents**  
> *Preloading hundreds of enterprise tool schemas dilutes model attention and inflates token costs. SkillPrism indexes skills out-of-context and injects only what the model needs, right when it needs it.*

[![npm version](https://img.shields.io/npm/v/@ritualdev-lab/skillprism?color=8b5cf6&style=flat-square)](https://www.npmjs.com/package/@ritualdev-lab/skillprism)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
<a href="https://github.com/RitualDev-Lab/SkillPrism/actions/workflows/test.yml"><img src="https://github.com/RitualDev-Lab/SkillPrism/actions/workflows/test.yml/badge.svg" alt="CI Tests" /></a>
[![Secured by AgentShield](https://img.shields.io/badge/Secured%20by-AgentShield%20Zero--Leak-8b5cf6?logo=shield&logoColor=white&style=flat-square)](https://agentshield.ritualdev.in/)

---

## ⚡ The Problem: Context Bloat & Attention Dilution

When autonomous coding agents (Claude Code, Cursor, Windsurf, Antigravity) connect to enterprise MCP servers or large API catalogs:
* **~24,500 Tokens Wasted**: Full JSON schemas for hundreds of endpoints are dumped into the system prompt on turn 1.
* **Model Hallucinations**: When models face 100+ tools, tool selection accuracy drops dramatically ("Lost in the Middle").
* **Token Cost Explosion**: Every reasoning turn repeatedly transmits schemas the agent never touches.

---

## 💡 The Solution: SkillPrism Progressive JIT Disclosure

SkillPrism moves the entire tool catalog **outside the LLM context**:
1. **Zero-State (~199 tokens)**: The agent prompt starts with only two meta-tools: `search_skills` and `load_skill`.
2. **Sub-Millisecond BM25 Hybrid Search (< 0.1 ms)**: The agent queries for capabilities by natural intent (e.g. *"query Postgres database"*).
3. **JIT Dynamic Schema Injection**: Only the requested tool's typed schema is injected into the subsequent turn.
4. **Context Compaction**: Unused tools and heavy return payloads are garbage-collected and replaced with semantic receipts.

---

## 🚀 Quickstart

### Installation

```bash
# Run CLI directly via npx
npx @ritualdev-lab/skillprism search "postgres database query"

# Or install locally
pnpm add @ritualdev-lab/skillprism
```

### Programmatic Usage

```typescript
import { SkillIndex } from "@ritualdev-lab/skillprism";

const index = new SkillIndex();

// Register tool schemas into out-of-context index
index.register({
  id: "postgres_query",
  name: "PostgreSQL Query Exec",
  summary: "Executes parameterized read queries against production PostgreSQL clusters",
  description: "Performs read-only SQL queries with built-in connection pooling and PII redaction.",
  category: "database",
  tags: ["sql", "postgres", "db", "query"],
  permissions: ["db:read"],
  parameters: [
    { name: "sql", type: "string", description: "The SQL statement", required: true },
    { name: "params", type: "array", description: "Query bind variables" }
  ]
});

// Import tools directly from standard MCP servers (tools/list)
index.importFromMcp(mcpToolsList);

// Search for matching skills with zero prompt bloat
const matches = index.search("fetch user records from postgres", 3);
console.log(matches[0].disclosureSnippet);
```

---

## 📊 Live Benchmark Results

```text
⚡ SkillPrism Token Optimization & Latency Benchmark

📦 Catalog Size: 100 Enterprise Tools
🔴 Unoptimized Preload Zero-State: ~11,989 tokens
🟢 SkillPrism JIT Zero-State:       ~326 tokens (3 meta-tools)
🚀 Upfront Token Savings:           97.3%
⏱️ Average Search Latency:          < 0.3 ms
💾 Payload Compaction Savings:      91.0%
```

---

## 💖 Community & Commercial Support

* **Website & Live Demo**: [skillprism.ritualdev.in](https://skillprism.ritualdev.in)
* **Donations**: Support independent open-source AI tooling research via [donation.rolenest.in](https://donation.rolenest.in).
* **Enterprise & Turnkey**: Need custom private MCP servers or enterprise skill gateways? Visit [mcp.ritualdev.in](https://mcp.ritualdev.in#enterprise) or contact `contact@ritualdev.in`.
* **Developer Inquiries & Support**: Reach out directly to `developer@ritualdev.in` or `support@ritualdev.in`.

---

## 📄 License

Apache-2.0 © 2026 [RitualDev Lab](https://github.com/RitualDev-Lab).
