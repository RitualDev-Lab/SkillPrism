# 05 — Enterprise VPC & Security Controls

## Air-Gapped & High-Availability Deployment
- Deploys via the canonical Helm chart in [`RitualDev-Lab/enterprise-governance-suite`](https://github.com/RitualDev-Lab/enterprise-governance-suite) (`helm/agentshield/templates/skillprism-redis-cluster.yaml`).
- Multi-AZ Redis Sentinel clustering with automatic local disk/LRU failover guarantees zero workflow downtime during Redis maintenance or partitions.
- Integrates with `agent-defense-hub` (`/api/v1/skillprism/status` & `/api/v1/skillprism/orchestrate`) for centralized fleet namespace orchestration.
- Cross-turn taint tracking (`src/taint-tracker.ts`) prevents sensitive tool outputs from propagating across untrusted tool calls.

## Security Policy
See [SECURITY.md](../SECURITY.md) or contact `security@ritualdev.in`.
