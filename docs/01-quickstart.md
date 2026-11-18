# 01 — SkillPrism Quickstart

**SkillPrism (`@ritualdev-lab/skillprism`)** is a Just-In-Time (JIT) MCP tool discovery, progressive skill disclosure, and semantic receipt compaction proxy that cuts multi-turn LLM prompt token overhead by up to **98%+** when stacked with native prompt caching.

## 1. Run Reproducible Token Compaction Benchmark
```bash
npx -y @ritualdev-lab/skillprism benchmark
# Or run the full 5-strategy comparative benchmark directly:
npx tsx benchmarks/token-compaction.ts
```

## 2. Initialize Non-Destructive IDE Config
```bash
npx -y @ritualdev-lab/skillprism init
```

## 3. Start Transparent MCP Proxy
```bash
npx -y @ritualdev-lab/skillprism proxy --port 4310
```

## Next Steps
- [02 — Architecture](02-architecture.md)
- [03 — Configuration & CLI Reference](03-configuration-and-cli.md)
- [04 — Integrations & MCP Proxying](04-integrations-and-mcp.md)
- [05 — Enterprise VPC & Security](05-enterprise-vpc-and-security.md)
