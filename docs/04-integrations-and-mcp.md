# 04 — Integrations & MCP Proxying

## Unified AgentShield Platform Routing
SkillPrism can be invoked directly through AgentShield's unified CLI:
```bash
npx @ritualdev-lab/agentshield compact benchmark
```

## Pairing with DevShelf 1-Click MCP Registry
Discover and install verified MCP tools into your local agent config via `npx devshelf install <tool-slug>`, then route upstream servers through SkillPrism to keep zero-state context usage under 210 tokens regardless of catalog size.

## OpenTelemetry FinOps Integration
`src/finops-exporter.ts` emits per-session token reduction, cache hit ratio, and USD savings telemetry compatible with Prometheus, Grafana, and Datadog.
