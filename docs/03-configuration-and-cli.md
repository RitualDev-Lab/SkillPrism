# 03 — SkillPrism Configuration & CLI Reference

## Core CLI Commands

| Command | Description |
| :--- | :--- |
| `skillprism init` | Non-destructively back up and configure local IDE MCP configs. |
| `skillprism proxy [--port 4310]` | Launch transparent stdio + HTTP/SSE MCP proxy server. |
| `skillprism benchmark` | Measure BPE token savings and search latency using `gpt-tokenizer`. |
| `npx tsx benchmarks/token-compaction.ts` | Run reproducible 5-strategy comparison (Raw vs. OpenAI/Anthropic Caching vs. SkillPrism JIT vs. Stacked). |

## Environment Variables

| Variable | Purpose |
| :--- | :--- |
| `CONTEXT_WINDOW_SIZE` | Override host LLM context window budget (e.g. `32000`, `200000`). |
| `SKILLPRISM_REDIS_SENTINELS` | Comma-separated Sentinel endpoints (`host:port`). Falls back automatically to local LRU if unreachable. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Export OpenTelemetry FinOps token-savings metrics. |
