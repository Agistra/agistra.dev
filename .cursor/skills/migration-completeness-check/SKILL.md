---
name: migration-completeness-check
description: "Use when the team lead points Architect at a prior agistra.dev hub path and asks it to check for or perform additional migration — trigger phrasing such as 'migrate my data from <path>', 'check what didn't get migrated', 'did we miss anything from my old hub', or 'do a completeness pass on <path>'. Walks the prior hub's full directory tree read-only, diffs it against the fixed scripted migration scope plus any existing migration report, and asks the team lead one clear question at a time about anything a scripted migration would never have discovered. Never writes or copies anything itself — every confirmed item is delegated to the existing migration primitives. Do not use for the first-run scripted migration prompt during `npm run setup` — that is unrelated, already-automated flow this skill does not replace."
---

Read and follow `skills/migration-completeness-check/SKILL.md` (canonical). Resolve scripts and assets relative to `skills/migration-completeness-check/`. This stub exists for platform skill discovery only.
