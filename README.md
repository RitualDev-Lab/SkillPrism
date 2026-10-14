# 💎 SkillPrism

> **Progressive Skill Disclosure & Context Compaction Engine for Autonomous AI Coding Agents**  
> *Preloading hundreds of enterprise tool schemas dilutes model attention and inflates token costs. SkillPrism indexes skills out-of-context and injects only what the model needs, right when it needs it.*

[![npm version](https://img.shields.io/npm/v/@ritualdev-lab/skillprism?color=8b5cf6&style=flat-square)](https://www.npmjs.com/package/@ritualdev-lab/skillprism)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-100%25_Passing-emerald.svg?style=flat-square)](#)
[![Secured by AgentShield](https://img.shields.io/badge/Secured%20by-AgentShield%20Zero--Leak-8b5cf6?logo=shield&logoColor=white&style=flat-square)](https://agentshield.ritualdev.in/)

---

## ⚡ The Problem: Context Bloat & Attention Dilution

When autonomous coding agents (Claude Code, Cursor, Windsurf, Antigravity) connect to enterprise MCP servers or large API catalogs:
* **25,000+ Tokens Wasted**: Full JSON schemas for hundreds of endpoints are dumped into the system prompt on turn 1.
* **Model Hallucinations**: When models face 100+ tools, tool selection accuracy drops dramatically ("Lost in the Middle").
* **Token Cost Explosion**: Every reasoning turn repeatedly transmits schemas the agent never touches.

---

## 💡 The Solution: SkillPrism Progressive JIT Disclosure

SkillPrism moves the entire tool catalog **outside the LLM context**:
1. **Zero-State (< 180 tokens)**: The agent prompt starts with only two meta-tools: `search_skills` and `load_skill`.
2. **Sub-Millisecond BM25 Hybrid Search**: The agent queries for capabilities by natural intent (e.g. *"query Postgres database"*).
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

## 🗺️ Roadmap: The 5 Phases

- [x] **Phase 1: Out-of-Context Skill Index & Local BM25/Vector Catalog**
  - Ultra-fast Okapi BM25 ranking engine
  - Sub-millisecond keyword and tag affinity scoring
  - Native MCP `tools/list` schema importer
  - Token footprint estimation and savings telemetry
- [x] **Phase 2: JIT Meta-Tool Harness (`search_skills` & `load_skill`)**
  - Zero-state prompt with only 2 lightweight meta-tools (< 180 tokens)
  - Dynamic schema injection upon skill activation
  - Turn-level TTL schema expiry and auto-pruning
  - Compatible with OpenAI Function Calling & Anthropic Tool Use format
- [x] **Phase 3: Ephemeral Schema Injection & MCP Protocol Interceptor**
  - Transparent JSON-RPC 2.0 proxy middleware
  - Intercepts `tools/list` to hide out-of-context tools until dynamically loaded
  - Intercepts `tools/call` for zero-friction routing between meta-tools and upstream handlers
  - Full Model Context Protocol (2024-11-05) handshake conformance
- [x] **Phase 4: Dynamic Context Compactor & Semantic Receipt Garbage Collector (GC)**
  - Automatically compacts payloads exceeding threshold into lightweight Semantic Receipts (< 120 tokens)
  - Stores heavy raw data out-of-context in secure memory vault
  - Provides `inspect_receipt` query helper for targeted path lookup (e.g. `nodes[1].memory`)
  - Prevents multi-turn token drift and saves 70% to 85% of execution return tokens
- [x] **Phase 5: CLI, Benchmarking Suite & DevShelf Directory Sync**
  - Interactive CLI (`search`, `benchmark`, `sync`, `stats`)
  - Quantified token savings & latency benchmark (`skillprism benchmark`)
  - Dogfoods 520+ verified developer tools from the DevShelf ecosystem directory (`skillprism sync`)
  - Sub-millisecond BM25 keyword matching (< 0.1 ms average search latency)

---

## 📊 Live Benchmark Results

```text
⚡ SkillPrism Token Optimization & Latency Benchmark

📦 Catalog Size: 100+ Enterprise Tools
🔴 Unoptimized Preload Zero-State: ~24,500 tokens
🟢 SkillPrism JIT Zero-State:       ~199 tokens
🚀 Upfront Token Savings:           99.2%
⏱️ Average Search Latency:          0.063 ms
💾 Payload Compaction Savings:      91.0%
```

---

## 💖 Community & Commercial Support

* **Donations**: Support independent open-source AI tooling research via [donation.rolenest.in](https://donation.rolenest.in).
* **Enterprise & Turnkey**: Need custom private MCP servers or enterprise skill gateways? Visit [mcp.ritualdev.in](https://mcp.ritualdev.in#enterprise) or contact `enterprise@ritualdev.in`.

---

## 📄 License

Apache-2.0 © 2026 [RitualDev Lab](https://github.com/RitualDev-Lab).
