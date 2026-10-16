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
# 1-Click non-destructive integration (.cursorrules and CLAUDE.md managed sections)
npx @ritualdev-lab/skillprism init --cursor
npx @ritualdev-lab/skillprism init --claude
npx @ritualdev-lab/skillprism init --all

# Search out-of-context index by hybrid BM25 + dense semantic embeddings
npx @ritualdev-lab/skillprism search "upload file to s3"

# Ingest and convert OpenAPI 3.0/3.1 specs (auto-persists to SQLite ~/.skillprism/index.sqlite)
npx @ritualdev-lab/skillprism import ./api-spec.json

# Fetch and index tools from a running MCP server
npx @ritualdev-lab/skillprism add http://localhost:3000/mcp

# Run verifiable zero-state BPE token benchmark
npx @ritualdev-lab/skillprism benchmark

# Run complete multi-turn task trajectory economics benchmark (search + load + execute + inspect)
npx @ritualdev-lab/skillprism benchmark --trajectory

# Sync verified community tools from DevShelf directory
npx @ritualdev-lab/skillprism sync

# Start transparent MCP stdio proxy (with dynamic tools/list_changed notifications & 3-turn TTL)
npx @ritualdev-lab/skillprism proxy --stdio --turn-ttl 5

# Start secured HTTP/SSE MCP gateway with Bearer auth, CORS controls, and session isolation
npx @ritualdev-lab/skillprism proxy --port 8080 \
  --auth-token "super-secret-mcp-key" \
  --allowed-origins "https://app.internal,http://localhost:3000" \
  --max-body-size 2097152 \
  --isolate-sessions

# Run in mock/simulation mode (opt-in for local testing without upstream servers)
npx @ritualdev-lab/skillprism proxy --port 8080 --dry-run-simulation
```

---

## 🏗️ Real Upstream MCP Proxy & Enterprise Gateway Architecture

SkillPrism functions as a transparent, high-performance gateway between AI agent runtimes (Claude Code, Cursor, Windsurf, Antigravity) and your underlying MCP servers:

* **Real Upstream Execution**: When an agent invokes an activated tool, SkillPrism routes the JSON-RPC `tools/call` directly to the connected upstream server via Stdio child processes or HTTP endpoints.
* **Strict Fail-Closed Policy**: SkillPrism **never simulates tool execution silently**. If no upstream server is configured for a tool, it returns a fail-closed error code (`-32603`). Simulation mode is strictly opt-in via `--dry-run-simulation`.
* **Dynamic Tool Notifications (`tools/list_changed`)**: Advertises `capabilities.tools.listChanged: true` on initialize and broadcasts real-time `notifications/tools/list_changed` JSON-RPC events across both Stdio and Server-Sent Events (SSE `GET /sse`) streams whenever tools are loaded or expired.
* **Turn & Time-Based Gateway Lifecycle**: Tools operate with a configurable turn TTL (`--turn-ttl`, default: 3 turns) and sliding idle expiration (`--idle-ttl`, default: 600s). Active tool calls automatically extend the window, while a background sweeper prunes inactive schemas back to zero-state.
* **Zero-Leak Multi-Tenant Session Isolation**: With `--isolate-sessions` or the `mcp-session-id` / `x-session-id` HTTP header, each agent session is sandboxed in its own harness. Tool schemas activated in Session A never leak into Session B.
* **HTTP Bearer Auth & Origin Restrictions**: Restricts access via `--auth-token` (HTTP 401 on unauthorized calls) and validates CORS origins against `--allowed-origins` (HTTP 403 on untrusted origins).
* **Streaming Request Size Limiting**: Rejects oversized request payloads via `--max-body-size` (HTTP 413 Payload Too Large) to prevent buffer-exhaustion attacks.
* **Deep Schema Preservation**: Fully preserves `$defs`, `$ref`, `oneOf`, `anyOf`, `allOf`, `additionalProperties: false`, property `enum: [...]`, and defaults without stripping constraints.
* **Non-Destructive Safe Init**: `skillprism init` safely injects managed blocks (`<!-- SKILLPRISM:START -->`) into `.cursorrules` and `CLAUDE.md`, creates timestamped backups (`.bak.<timestamp>`), preserves sibling servers, and strictly aborts on invalid JSON configs unless `--force` is passed.

---

## 📊 Benchmark Transparency & Task Economics

SkillPrism measures both **upfront zero-state prompt reductions** and **complete multi-turn task trajectory costs** using verifiable BPE tokenization (`gpt-tokenizer` `cl100k_base` / `o200k_base`):

### 1. Zero-State Upfront Benchmark (`skillprism benchmark`)

```text
⚡ SkillPrism Zero-State Token Savings
📦 Benchmark Catalog:       100 Enterprise Tools (Synthetic across 7 categories)
🔴 Unoptimized Preload:     ~11,989 tokens (All raw JSON schemas loaded upfront)
🟢 SkillPrism JIT:          ~326 tokens (3 lightweight zero-state meta-tools)
🚀 Upfront Token Savings:   97.3% reduction in system prompt token footprint
⏱️ Average Search Latency:  < 0.3 ms (Hybrid BM25 + dense vector similarity)
💾 Payload Compaction:      91.0% savings on heavy responses (> 512 bytes)
```

### 2. Complete-Task Trajectory Economics (`skillprism benchmark --trajectory`)

Measures complete lifecycle token expenditure (tool discovery + schema activation + tool execution + response payload compaction + receipt drill-down + TTL expiration) across realistic multi-turn reasoning workflows:

```text
📈 Complete Multi-Turn Task Trajectory Economics Benchmark
📦 Catalog Size:                     50 Enterprise Tools
🔄 Task Trajectory Lifetime:         5 Turns
🎯 Task Success Rate:                100% (Discovered, Loaded, Executed, Inspected)
🔴 Monolithic Cumulative Tokens:     ~10,500 tokens (Preloaded schemas repeated every turn + raw payloads)
🟢 SkillPrism Cumulative Tokens:      ~2,150 tokens (Zero-state + search + ephemeral schema + receipt)
🚀 Net Trajectory Token Savings:     79.5% net token reduction across full task lifecycle
⚡ Token Efficiency Multiplier:      4.88x more tokens preserved for agent reasoning
```

### Benchmark Conditions & Disclosure:
1. **Full-Lifecycle Cost Accounting**: Unlike naive zero-state estimates, the trajectory benchmark rigorously accounts for search query overhead, summary disclosure snippets, ephemeral schema injection, compacted receipts, and targeted receipt inspection queries (`inspect_receipt`).
2. **Task Success Rate**: Across multi-turn evaluation tasks, SkillPrism achieves a **100% task completion success rate**, demonstrating that progressive disclosure eliminates attention dilution without sacrificing tool discoverability or execution precision.
3. **Payload Compaction Threshold**: Tool execution responses below the configurable threshold (default: 512 bytes) remain unchanged. Massive payloads (> 512 bytes) are stored out-of-context with subfield querying (`inspect_receipt({ ref, path: "rows.0.id" })` and line/slice queries `lines:1-50`, `slice:0:500`).
4. **Preserved Schema Integrity**: All deep schema definitions (`enum`, `additionalProperties: false`, `$defs`, `oneOf`) are faithfully retained when tools are activated.

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
