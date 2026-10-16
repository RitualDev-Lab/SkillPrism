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

## 🛠️ Client Integration Adapters

Connect SkillPrism as a transparent MCP server to eliminate tool prompt bloat in your favorite AI coding agent:

### 1. Claude Code CLI

Add SkillPrism to your Claude Code workspace:

```bash
claude mcp add skillprism -- npx -y @ritualdev-lab/skillprism proxy --stdio
```

Or configure directly in `claude.json`:
```json
{
  "mcpServers": {
    "skillprism": {
      "command": "npx",
      "args": ["-y", "@ritualdev-lab/skillprism", "proxy", "--stdio"]
    }
  }
}
```

### 2. Cursor IDE (`~/.cursor/mcp.json`)

Add to your Cursor global or workspace MCP configuration:

```json
{
  "mcpServers": {
    "skillprism": {
      "command": "npx",
      "args": ["-y", "@ritualdev-lab/skillprism", "proxy", "--stdio"]
    }
  }
}
```

### 3. Windsurf IDE (`~/.codeium/windsurf/mcp_config.json`)

```json
{
  "mcpServers": {
    "skillprism": {
      "command": "npx",
      "args": ["-y", "@ritualdev-lab/skillprism", "proxy", "--stdio"]
    }
  }
}
```

---

## 💻 CLI Commands

```bash
# 1-Click integration for Cursor Rules (.cursorrules) and Claude Code (CLAUDE.md)
npx @ritualdev-lab/skillprism init --cursor
npx @ritualdev-lab/skillprism init --claude
npx @ritualdev-lab/skillprism init --all

# Search out-of-context index by hybrid BM25 + dense semantic embeddings
npx @ritualdev-lab/skillprism search "upload file to s3"

# Ingest and convert OpenAPI 3.0/3.1 specs (auto-persists to SQLite ~/.skillprism/index.sqlite)
npx @ritualdev-lab/skillprism import ./api-spec.json

# Fetch and index tools from a running MCP server
npx @ritualdev-lab/skillprism add http://localhost:3000/mcp

# Run verifiable BPE token benchmark
npx @ritualdev-lab/skillprism benchmark

# Sync verified community tools from DevShelf directory
npx @ritualdev-lab/skillprism sync

# Start transparent MCP stdio or HTTP proxy (forwards to real upstream MCP tools)
npx @ritualdev-lab/skillprism proxy --stdio
npx @ritualdev-lab/skillprism proxy --port 8080

# Run in mock/simulation mode (opt-in for local testing without upstream servers)
npx @ritualdev-lab/skillprism proxy --port 8080 --dry-run-simulation
```

---

## 🏗️ Real Upstream MCP Proxy Architecture

SkillPrism functions as a transparent, high-performance gateway between AI agent runtimes (Claude Code, Cursor, Windsurf) and your underlying MCP servers:

* **Real Upstream Execution**: When an agent invokes an activated tool, SkillPrism routes the JSON-RPC `tools/call` directly to the connected upstream server via Stdio child processes or HTTP endpoints.
* **Strict Fail-Closed Policy**: SkillPrism **never simulates tool execution silently**. If no upstream server is configured for a tool, it returns a fail-closed error code (`-32603`). Simulation mode is strictly opt-in via `--dry-run-simulation`.
* **Error & Status Preservation**: Real upstream errors (such as database connection timeouts, permission denials, or validation failures) are faithfully preserved and returned with `isError: true` so the agent can self-correct.
* **Non-Destructive Initialization**: Running `skillprism init` inspects your existing `.mcp.json`, automatically creates a safety backup (`.mcp.json.bak`), preserves all sibling servers (GitHub, Postgres, Filesystem, etc.), and cleanly patches the `skillprism` gateway entry.

---

## 📊 Benchmark Transparency & Methodology

```text
⚡ SkillPrism Token Optimization & Latency Benchmark

📦 Benchmark Catalog:       100 Enterprise Tools (Synthetic across 7 categories)
🔴 Unoptimized Preload:     ~11,989 tokens (All raw JSON schemas loaded upfront)
🟢 SkillPrism JIT:          ~326 tokens (3 lightweight zero-state meta-tools)
🚀 Upfront Token Savings:   97.3% reduction in system prompt token footprint
⏱️ Average Search Latency:  < 0.3 ms (Hybrid BM25 + dense vector similarity)
💾 Payload Compaction:      91.0% savings on heavy responses (> 512 bytes)
```

### Benchmark Conditions & Disclosure:
1. **Synthetic vs. Real-World Catalogs**: The 100-tool benchmark uses representative enterprise schemas (averaging 3-5 typed properties, validation constraints, and descriptions). In production setups with large OpenAPI conversions or multi-server MCP configurations (e.g., Jira, GitHub, Slack, AWS, Postgres), real-world prompt savings typically range between **85% and 98%** depending on schema complexity.
2. **Tokenizer**: Measurements are calculated using `gpt-tokenizer` (OpenAI BPE encoding / `cl100k_base` and `o200k_base` compatible).
3. **Payload Compaction Threshold**: Tool execution responses below 512 bytes are returned verbatim without compaction overhead. Responses exceeding 512 bytes are stored in the local SQLite receipt vault (`~/.skillprism/index.sqlite`), and a structured semantic receipt (`receipt:<tool>:<hash>`) is returned to prevent context explosion. Models can inspect specific receipt subfields on-demand using `inspect_receipt({ ref, path })`.

---

## 💖 Community & Commercial Support

* **Website & Live Demo**: [skillprism.ritualdev.in](https://skillprism.ritualdev.in)
* **Sponsorship**: Support independent open-source AI tooling research via [Dodo Payments](https://checkout.dodopayments.com/buy/pdt_0NpjONGugY5QkrFDUaPva).
* **Enterprise & Turnkey**: Need custom private MCP servers or enterprise skill gateways? Visit [mcp.ritualdev.in](https://mcp.ritualdev.in#enterprise) or contact `contact@ritualdev.in`.
* **Developer Inquiries & Support**: Reach out directly to `developer@ritualdev.in` or `support@ritualdev.in`.

---

## 👥 Team & Contributors

SkillPrism is initiated and maintained by the team at [RitualDev Lab](https://github.com/RitualDev-Lab) and expanded by the open-source AI community.

### 🛡️ Core Team & Direct Access Admins

<table align="center">
  <tr>
    <td align="center" width="180">
      <a href="https://github.com/divyanshujethi">
        <img src="https://github.com/divyanshujethi.png" width="80" style="border-radius: 50%;" alt="Divyanshu Jethi"/><br />
        <sub><b>Divyanshu Jethi</b></sub>
      </a><br />
      <sub>🚀 Founder &amp; Lead</sub><br />
      <sub>🔑 <b>Direct Access Admin</b></sub>
    </td>
    <td align="center" width="180">
      <a href="https://github.com/Sakshisharma1616">
        <img src="https://github.com/Sakshisharma1616.png" width="80" style="border-radius: 50%;" alt="Sakshi Sharma"/><br />
        <sub><b>Sakshi Sharma</b></sub>
      </a><br />
      <sub>🎨 Core Maintainer &amp; Product</sub><br />
      <sub>🔑 <b>Direct Access Admin</b></sub>
    </td>
    <td align="center" width="180">
      <a href="https://github.com/Ritual-Dev-Git">
        <img src="https://github.com/Ritual-Dev-Git.png" width="80" style="border-radius: 50%;" alt="RitualDev"/><br />
        <sub><b>RitualDev</b></sub>
      </a><br />
      <sub>⚙️ Core Maintainer &amp; Infra</sub><br />
      <sub>🔑 <b>Direct Access Admin</b></sub>
    </td>
    <td align="center" width="180">
      <a href="https://github.com/Divyanshu-hub-dotcom">
        <img src="https://github.com/Divyanshu-hub-dotcom.png" width="80" style="border-radius: 50%;" alt="Divyanshu-hub-dotcom"/><br />
        <sub><b>Divyanshu-hub-dotcom</b></sub>
      </a><br />
      <sub>🛠️ Core Member</sub>
    </td>
    <td align="center" width="180">
      <a href="https://github.com/ayushxx01">
        <img src="https://github.com/ayushxx01.png" width="80" style="border-radius: 50%;" alt="Ayush"/><br />
        <sub><b>Ayush</b></sub>
      </a><br />
      <sub>🛡️ Core Maintainer &amp; Triage</sub>
    </td>
  </tr>
</table>

### 🌟 Community Contributors & Builders

<p align="center">
  <a href="https://github.com/RitualDev-Lab/SkillPrism/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=RitualDev-Lab/SkillPrism" alt="SkillPrism Contributors" />
  </a>
</p>

<p align="center">
  Huge thanks to all our open-source <a href="https://github.com/RitualDev-Lab/SkillPrism/graphs/contributors">Contributors</a>! We warmly welcome issues, feedback, and pull requests.
</p>

---

## 📄 License

Apache-2.0 © 2026 [RitualDev Lab](https://github.com/RitualDev-Lab).
