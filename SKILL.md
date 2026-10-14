---
name: skillprism
description: Progressive skill disclosure & context compaction engine for autonomous coding agents. Use when agent prompts suffer from tool schema bloat or when indexing and loading tools on-demand via BM25.
---

# SkillPrism Agent Skill

SkillPrism solves the **Tool-Schema Context Bloat** problem for autonomous AI agents. Rather than loading hundreds of full tool schemas into turn-1 system prompts, SkillPrism keeps schemas out-of-context and dynamically activates them just-in-time (JIT).

## Core Directives

1. **Zero-State Initialization**:
   - In turn 1, provide only two meta-tools: `search_skills` and `load_skill`.
   - Never dump dozens of static tool definitions into the prompt.

2. **JIT Skill Discovery**:
   - When a specific operation is required (e.g. querying a database, interacting with S3, or dispatching an API call), invoke `search_skills({ intent: "<natural language intent>" })`.
   - Select candidate tools based on disclosure summary, score, and token footprint.

3. **Ephemeral Activation**:
   - Invoke `load_skill({ skill_id: "<tool_id>" })` to inject the schema for the active turn.
   - Execute the tool call using the injected parameters.

4. **Semantic Context Compaction**:
   - Tool outputs exceeding 512 bytes should be vaulted into semantic receipts via `ContextCompactor`.
   - Use `inspect_receipt` to drill down into specific keys without bloating subsequent context windows.

## CLI Commands

```bash
# Search out-of-context catalog
npx @ritualdev-lab/skillprism search "<intent>"

# Run token optimization benchmark
npx @ritualdev-lab/skillprism benchmark

# Sync 520+ verified community tools from DevShelf directory
npx @ritualdev-lab/skillprism sync

# Run transparent local MCP proxy
npx @ritualdev-lab/skillprism proxy --port 8080
```
