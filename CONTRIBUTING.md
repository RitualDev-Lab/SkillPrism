# Contributing to SkillPrism

We welcome contributions from the open-source community to improve token optimization, out-of-context indexing, and context compaction for autonomous AI agents.

## Development Setup

SkillPrism is built with Node.js and TypeScript. We recommend `pnpm` as the package manager:

```bash
# Clone the repository
git clone https://github.com/RitualDev-Lab/SkillPrism.git
cd SkillPrism

# Install dependencies
pnpm install 

# Run the test suite
pnpm test

# Build distributions
pnpm run build
```

## Ground Rules

1. **Zero Runtime Dependencies**: The core engine must remain lightweight and zero-runtime-dependency.
2. **Sub-Millisecond Search**: Ensure BM25 indexing algorithms and search loops maintain sub-millisecond execution overhead.
3. **Strict Typings & Linting**: All contributions must pass `pnpm test` and `pnpm run lint`.
4. **Security Awareness**: Never accept unvalidated descriptions or unescaped prompt inputs from untrusted MCP registries.

## Submitting Pull Requests

1. Fork the repo and create a feature branch (`git checkout -b feat/my-feature`).
2. Add unit tests for your changes under `tests/`.
3. Commit with standard conventional commit messages (`feat: ...`, `fix: ...`).
4. Submit a Pull Request targeting `main`.

---

## 🏛️ Project Governance & Direct Access Admins

SkillPrism is governed by [RitualDev Lab](https://github.com/RitualDev-Lab). Core releases, signing keys, and repository admin controls are managed by our **Direct Access Admins**:

- **Divyanshu Jethi** ([@divyanshujethi](https://github.com/divyanshujethi)) &mdash; Founder & Lead
- **Sakshi Sharma** ([@Sakshisharma1616](https://github.com/Sakshisharma1616)) &mdash; Core Maintainer & Product
- **RitualDev** ([@Ritual-Dev-Git](https://github.com/Ritual-Dev-Git)) &mdash; Core Maintainer & Infra

