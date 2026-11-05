## 📝 Summary of Changes

<!-- Provide a concise description of what this PR does and why it is needed. -->

## 🛡️ Enterprise Security & Quality Checklist

Before submitting this Pull Request, please confirm all requirements below:

- [ ] **Zero-Leak Secret Defense**: Verified no unmasked API keys, tokens, or environment credentials exist in the diff (`agentshield ci --enforce`).
- [ ] **ReDoS Safety**: Any new regular expressions are bounded with finite character classes and tested for catastrophic backtracking.
- [ ] **Automated Tests**: Unit tests added or updated to cover new logic (`npm test` passes 100%).
- [ ] **Code Quality**: Linter and code formatting checks pass (`npm run lint` / `npx biome check .`).
- [ ] **Air-Gapped Isolation**: Verified code operates 100% locally when `AGENTSHIELD_AIR_GAPPED=1` (zero outbound phone-homes).
- [ ] **Documentation**: Updated README.md, CLI `--help`, or `docs/` where applicable.

---

## 🏷️ Change Category

- [ ] 🐛 **Bug Fix** (non-breaking fix resolving an issue)
- [ ] ✨ **New Feature** (non-breaking functional enhancement)
- [ ] 🔒 **Security Hardening** (patch for potential vulnerability or evasion)
- [ ] ⚡ **Performance Optimization** (latency, memory, or throughput improvement)
- [ ] 💥 **Breaking Change** (fix or feature requiring API / configuration migration)
- [ ] 📚 **Documentation** (typo fix, architecture guide, or examples)
