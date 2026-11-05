# 🛡️ RitualDev Lab Security Policy & Vulnerability Disclosure

> **Applies to**: All 25 repositories under `@RitualDev-Lab`  
> **Official Intake**: `security@ritualdev.in`  
> **PGP Public Key**: [https://ritualdev.in/pgp-key.txt](https://ritualdev.in/pgp-key.txt)  
> **Security Policy (RFC 9116)**: [https://ritualdev.in/.well-known/security.txt](https://ritualdev.in/.well-known/security.txt)  
> **Trust Center**: [https://ritualdev.in/trust](https://ritualdev.in/trust)  
> **Effective Date**: November 2026  

---

## 1. Supported Versions & SLA Guarantees

RitualDev Lab provides active security patching and vulnerability mitigation for the following operational software branches:

| Project / Repository | Supported Versions | Security Support Status | Patch Turnaround SLA |
| :--- | :--- | :---: | :---: |
| **AgentShield** (`@ritualdev-lab/agentshield`) | `v0.2.x`, `main` | ✅ Active (24/7/365) | **< 24 Hours** (Critical) |
| **DBShield** (`@ritualdev-lab/dbshield`) | `v0.2.x`, `main` | ✅ Active (24/7/365) | **< 24 Hours** (Critical) |
| **SkillPrism** (`@ritualdev-lab/skillprism`) | `v0.1.x`, `main` | ✅ Active | **< 48 Hours** |
| **WebSecAuditor** (`web-sec-auditor`) | `v0.1.x`, `main` | ✅ Active | **< 48 Hours** |
| **GitWhisper** (`@ritualdev-lab/gitwhisper`) | `v0.1.x`, `main` | ✅ Active | **< 48 Hours** |
| **Ritual Agent Defense IDE** | Latest published | ✅ Active | **< 48 Hours** |
| **ritualdev-web** (`ritualdev.in`) | Production `main` | ✅ Active | **< 12 Hours** |

---

## 2. Reporting a Security Vulnerability

If you discover a security vulnerability, zero-day evasion, or sensitive data leakage within any RitualDev Lab repository or utility, please report it through our coordinated disclosure channels:

1. **Email Intake**: Dispatch encrypted details to `security@ritualdev.in`.
2. **PGP Encryption**: For confidential findings, encrypt communications using our official PGP key at [https://ritualdev.in/pgp-key.txt](https://ritualdev.in/pgp-key.txt).
3. **GitHub Private Vulnerability Reporting**: You may also utilize GitHub's Private Vulnerability Reporting feature on any individual repository under `RitualDev-Lab`.

### Response & Triage SLA
- **Initial Response & Human Triage**: **< 1 hour** for P1 critical severity; **< 4 hours** for P2 high severity.
- **Triage Assessment & Status Updates**: Provided every **12 hours** until full resolution.
- **Coordinated Disclosure Policy**: We request a **90-day embargo** following notification to allow for patch deployment and upstream consumer notification before public disclosure.

---

## 3. Statutory Compliance & Data Protection

RitualDev operates under strict **Zero-Data-Retention** and **Local-First** principles:
- **Indian Digital Personal Data Protection Act, 2023 (DPDP Act)**: Zero lines of customer code, API tokens, or prompts are transmitted or stored by RitualDev systems.
- **European Union General Data Protection Regulation (GDPR)**: Execution occurs 100% locally on developer machines or inside customer VPC runners; zero cross-border personal data transfers occur under Chapter V.
- **NIST SP 800-218 & US Executive Order 14028**: All releases include automated CycloneDX / SPDX Software Bill of Materials (SBOMs) with cryptographic SLSA Level 3 provenance.

---

## 4. Bounty & Hall of Fame Acknowledgments

Valid, responsible security vulnerability disclosures are publicly recognized on our [Security Hall of Fame](https://ritualdev.in/advisories) and eligible for discretionary bounties based on CVSS 3.1 severity impact.
