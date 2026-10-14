# Contributing to agistra.dev

Thank you for your interest in contributing! This hub is the public deploy output of a
private source repository (`setchin-agent-profiles`). Pull requests land here first;
accepted changes are ported back into the private source by the maintainer.

## What we welcome

- Bug fixes and documentation improvements
- New or improved agent skills (files under `skills/`)
- Improvements to existing agent profiles (`.claude/agents/`, `.cursor/agents/`)
- Deploy pipeline fixes (`pipelines/deploy/`)
- Example projects, templates, and tooling additions

**Direct PRs are welcome** for everything in that list. You do not need to open an issue first.

## Security-critical paths — issue first

A small number of paths contain natural-language instructions that control when agents
stop versus proceed autonomously. Changes here require a discussion issue before a PR,
because code-level tools (CodeQL, tests) cannot detect a subtly weakened sentence the
way they would catch a code bug. A structural review gate (`CODEOWNERS`) enforces this —
the maintainer's sign-off is required before these PRs can merge, regardless of CI status.

**Open an issue first if your PR touches:**

- `skills/agent-foundations/SKILL.md` — VBR/WAL/security baseline, stop-vs-proceed logic
- Any wording that governs when an agent is allowed to act autonomously
- Ticket lifecycle gate logic (`skills/ticket-lifecycle-mode/SKILL.md`)
- `CLAUDE.md` — session startup rules and absolute prohibitions
- `CONTRIBUTING.md` or `CODEOWNERS` themselves

When in doubt, open an issue. A quick discussion avoids a round-trip review cycle.

## Port-back notice

`agistra.dev` is a deploy output: changes committed here directly will be overwritten by
the next deploy unless they are also ported back into the private source repo.
When your PR is accepted, the maintainer creates a port-back task and applies your delta
to the source. You do not need to do anything — but do note that a merge here is not
the end of the chain.

## What not to commit

The CI `no-personal-data` check will fail your PR if it includes:

- `workspace.config.json` — gitignored personal config (name, org, API tokens)
- `memory/*.md` — gitignored per-agent live state (task history, HOT/WARM/COLD entries)
- `.gitignore` changes that un-gitignore either of the above
- Real credentials (Telegram bot tokens, group IDs, API keys) anywhere in the diff

If the check fails on a false positive (it shouldn't, but if it does), open an issue
describing what triggered it so the check can be refined.

## CI checks

Every PR runs:

| Check | What it does |
|-------|-------------|
| CodeQL | Static analysis for JavaScript/TypeScript security issues |
| Dependency Review | Flags new dependencies with HIGH or CRITICAL CVEs |
| No Personal Data | Blocks accidental commit of personal workspace config or memory |

All three must pass before review. `CODEOWNERS`-gated PRs additionally require maintainer
sign-off regardless of CI status.

## Development setup

```bash
git clone https://github.com/Agistra/agistra.dev
cd agistra.dev
npm run setup        # configure workspace.config.json (gitignored — stays local)
npm run doctor       # verify hub health
```

Useful scripts:

```bash
npm run dispatch     # show the current work queue
npm run scan <proj>  # scan a project for new tasks
```

## Questions

Open an issue. The maintainer checks regularly.
