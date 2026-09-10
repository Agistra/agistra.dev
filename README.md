# Agistra Dev

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-0.2.3-blue.svg)](VERSION)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)

[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-blue.svg)](.claude/agents)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-supported-blue.svg)](.github/agents)
[![Cursor](https://img.shields.io/badge/Cursor-supported-blue.svg)](.cursor/agents)
[![Codex](https://img.shields.io/badge/Codex-supported-blue.svg)](.codex/agents)

> Agistra Dev AI Team — Architect, Builder, Tester, and Router — that plan, build, test, and coordinate your software projects with shared memory, a live task queue, GitHub Issues and Telegram integration, ticket lifecycle tracking, and a project health scanner that keeps the whole team on the same page across every session and project.

Run [scan](#project-health-scanner) on any existing project to analyse it and generate the first batch of tasks automatically. No manual setup required.

**[Get started →](#quick-start)** · [GitHub](https://github.com/vsetchinfc/agistra.dev) · Open source

---

## Contents

- [The problem with AI-assisted development today](#the-problem-with-ai-assisted-development-today)
- [How Agistra solves it](#how-agistra-solves-it)
- [The team](#the-team)
- [Built with Agistra](#built-with-agistra)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Project health scanner](#project-health-scanner)
- [Task file format](#task-file-format)
- [Agent memory](#agent-memory)
- [Ticket lifecycle](#ticket-lifecycle)
- [Upgrade path](#upgrade-path)
- [Open source](#open-source)

---

## The problem with AI-assisted development today

You know how it goes.

You open a new session and spend the first 15 minutes re-explaining your project — the stack, the decisions you already made, what was finished last time, what broke. The AI builds something reasonable. You close the tab. Tomorrow you start over.

**Context resets are the real cost.** Not tokens. Not speed. The restart is a tax.

And it gets worse when there's more than one of you. AI is a solo tool. It doesn't know your team's workflow, who owns what, or what state the ticket is in. You become the glue — tracking tasks in your head, copying outputs between sessions, chasing down what the AI actually shipped versus what it said it shipped.

Here's what happens in practice:

- **Decisions don't survive sessions.** You worked through an implementation approach — the tradeoffs, what you ruled out, the pattern you settled on. The next session doesn't know any of that. Instead of checking, it makes its own assumptions. You find the wrong call after it's already wired in.

- **Architecture drift.** The AI doesn't stay in the style of your existing codebase. It introduces different patterns, different contracts, adds abstractions that weren't asked for. You wanted one feature; you got an uninvited refactor alongside it.

- **Over-engineering trap.** AI defaults toward more complexity — extra error handling, extra layers, edge-case coverage for problems that can't happen in your system. The problem was simple. The solution shouldn't have to be complex.

- **No structured handoff.** No TDD gate. No QA step. The same agent that wrote the code declares it done — and when it "tests," it tests what it knows works, not what the spec requires. Bugs ship.

- **You're the project manager.** Tracking task state, prioritizing the backlog, deciding what the AI works on next — all in your head, all reloaded every session.

- **Nobody's watching what degrades.** Test coverage quietly drops. TODOs accumulate. CI/CD gaps widen. No one notices until it's already a problem.

---

## How Agistra solves it

Agistra gives AI a team structure with memory, a shared task queue, and a ticket workflow — so the context lives in the system, not in your head.

**Memory that persists across sessions.** Each agent maintains a HOT / WARM / COLD memory file, updated at the start and end of every session. Cold restarts become warm pickups.

**A shared task queue.** Tasks live in the hub repo as files, not in a chat transcript. Every agent reads the same queue. Nothing gets lost between sessions.

**Role-separated workflow.** Architect scopes work and produces PRDs so Builder gets clear requirements, not open-ended questions. Tester verifies the spec against the running app — never the same agent that built it, never looking at the code. Each agent knows its lane and the lifecycle rules for its role — no improvising.

**Enforced engineering discipline.** Builder runs in `software-engineer-mode`: it reads the codebase before touching it, matches existing patterns, and implements only what the ticket specifies. Scope expansion, uninvited abstractions, and unnecessary complexity don't get a foothold.

**Ticket lifecycle with gates.** Work moves through defined states (`ready-for-implementation` → `in-progress` → `ready-for-qa` → `qa-passed`) with explicit entry gates. Builder can't declare QA done. Tester can't skip the handoff payload check.

**Project health scanner.** Five-perspective automated scoring surfaces what's degrading before it becomes a problem — test coverage, CI/CD gaps, debug hygiene, documentation, infrastructure readiness.

**Human authority at the trust boundaries.** Agents handle the execution loop. You approve scope before Builder starts, own every merge and close decision, and stay the only authority on auth, payments, migrations, and infrastructure. Sensitive work never enters the automated lane. The third consecutive failure on any ticket parks unconditionally — the system stops and waits for your call.

**GitHub Issues + Telegram integration.** Tickets flow from GitHub Issues into the task queue. Telegram relay keeps the remote team in the loop without leaving the workflow.

---

## The team

| Agent | Role | What it does |
| --- | --- | --- |
| [**Architect**](docs/ARCHITECT.md) | Planning & design | Morning briefing, backlog creation, architecture decisions, task file generation |
| [**Builder**](docs/BUILDER.md) | Implementation | Engineering delivery with TDD gate, self-review, QA readiness checks |
| [**Tester**](docs/TESTER.md) | QA execution | Ticket verification, browser testing, Playwright automation, PASS/FAIL/BLOCKED verdicts |
| [**Router**](docs/ROUTER.md) | Relay & coordination | Inbound classification, cross-team routing, Telegram relay, audit trail |

Each agent runs in its own Claude Code workspace with its own identity, memory file, skills, and lifecycle role bindings. Architect orchestrates the others via the shared task queue — no agent talks to another directly except through defined handoff contracts.

---

## Built with Agistra

![vladsetchin.me preview](pipelines/deploy/assets/vlad.setchin-me.png)

**[vladsetchin.me](https://vladsetchin.me)** — a personal portfolio and blog, planned and built end-to-end through Agistra's own ticket workflow: GitHub issues, task files in `projects/vladsetchin.me/`, feature branches, and PRs, the same loop described above. Design decisions, content passes, and ongoing iteration all run through the same Architect → Builder → Tester lifecycle as any other project added with `npm run scan`.

---

## Quick start

### 1. Clone or fork the hub

```powershell
git clone https://github.com/vsetchinfc/agistra.dev.git my-hub
cd my-hub
```

### 2. Claude, Cursor, GitHub Copilot, Codex

Out of the box, Agistra provides agent definitions for claude, cursor, GitHub Copilot, and Codex. You can remove the ones you don't need. See .claude, .cursor, .github, and .codex folders for details.

The memory files in `memory/` are shared between all models — if you switch from Claude to Cursor, the same memory carries over. Skills are also model-agnostic — if you switch models, the same skills load.

**Skill layout:** canonical content lives in `skills/<name>/` (full trees). Platform paths `.github/skills/` and `.codex/skills/` hold stub `SKILL.md` files for discovery only — they point agents at the canonical copy. Dispatch injects skill content from `skills/` (the deployed hub default `--skills-root`).

### 2. Use VS Code, Cursor, or Claude Code

You can use VS Code, Cursor, Claude Code, or Codex to interact with the agents. Open my-hub and my-project workspaces in the same editor workspace. You will be able to use cli commands in the terminal to generate tasks and produce prompts to interact with agents.

### 3. Add your first project

Every time you add a new project by running `npm run scan <my-project>`, the project is added to projects and project related tasks are generated.

The best structure is to have the project workspace folder next to my-hub.

```text
my-hub/
  projects/
    my-project/
      task-1_todo_my_first-task.md
      task-2_todo_another-task.md
/my-project/
  src/
  README.md
```

## Project health scanner

`scan` scores your project across six perspectives, each 0.0–1.0:

| ID  | Perspective | What it measures                                       |
| --- | ----------- | ------------------------------------------------------ |
| SYS | System      | File complexity, directory cohesion, tsconfig, CI/CD   |
| TST | Test        | Test file ratio, test script presence                  |
| USR | User        | README quality, package description, changelog         |
| ANL | Analytics   | CI/CD automation, commit fix-rate, uncommitted changes |
| DBG | Debug       | TODO/FIXME density, console.log hygiene                |
| CTX | Context     | Deployed agent profile size, merged skill count        |

```text
Perspective Scores
──────────────────────────────────────────────────
  SYS  System       ████████░░  0.80
  TST  Test         ████░░░░░░  0.45 ▼0.10 ← lowest
  USR  User         ████████░░  0.80 ▲0.05
  ANL  Analytics    ██████░░░░  0.60
  DBG  Debug        █████░░░░░  0.55 →
  CTX  Context      ███████░░░  0.70
──────────────────────────────────────────────────
       Overall      ██████░░░░  0.65 ▲0.01
```

Scores and trends (▲ up ▼ down → unchanged) are saved to `projects/<project>/health.json` after every scan. Re-run scan any time — it skips findings that already have task files.

---

### 4. Dispatch work to agents

Open an Agent chat with this hub folder open in your workspace. Each agent reads its profile and memory before starting work — include both filenames in your prompt:

This workspace has multiple root folders. Always prefix paths with the hub folder name so the agent looks in the right place:

```text
@architect Read <hub>/.cursor/agents/architect.md then <hub>/memory/architect.md. Then: you are in architecture mode. Review <project> and create a planning backlog.

1. Read the codebase — README, src/, existing issues if accessible
2. Check projects/<project>/ for existing task files
3. Review open GitHub issues at <org>/<project> if accessible
4. Create task files in projects/<project>/ for all work not already covered

Task file naming: task_N_todo_<short-slug>.md
```

```text
@builder Read <hub>/.cursor/agents/builder.md then <hub>/memory/builder.md. Then: implement projects/<project>/task_N_todo_<slug>.md
```

```text
@tester Read <hub>/.cursor/agents/tester.md then <hub>/memory/tester.md. Then: QA projects/<project>/task_N_todo_<slug>.md
```

Replace `<hub>` with the hub folder name (e.g. `agistra.dev`). Without the prefix, relative paths resolve against whichever workspace root is active — typically the project repo, not the hub.

---

## CLI reference

Run from the hub directory. Replace `<project>` with your project name.

```powershell
npm run setup                     # first-time wizard (re-run to update config)
npm run list                      # show pending tasks across all projects
npm run scan     -- <project>     # scan project and generate task files
npm run dispatch -- <project>     # print the current task prompt
npm run advance  -- <project>     # mark current task done, show next
npm run launch   -- <project>     # launch Claude in the project directory
```

Target a specific task:

```powershell
node pipelines/deploy/index.js dispatch <project> --task 6
```

Advance and immediately launch Claude on the next task:

```powershell
npm run advance -- <project> && npm run launch -- <project>
```

Preview what `scan` would generate without writing files:

```powershell
node pipelines/deploy/index.js scan <project> --dry-run
```

### Install an optional skill

Some agents reference optional skills that aren't bundled by default — for example, Builder's `frontend-design` skill. Install one when you need it:

```powershell
npm run install-skill -- frontend-design
```

This fetches the named skill directly from its declared source into this hub's own `skills/<name>/`. Re-running is idempotent — if nothing changed upstream, it reports `unchanged` rather than rewriting the file. An agent profile that references an optional skill works fine before you install it; the skill is simply treated as not yet available, not as an error.

### Nightly dreaming (Windows only)

On Windows, `npm run setup` asks whether to enable nightly automated end-of-day memory
consolidation — a Windows Scheduled Task that runs headless Claude Code (`claude -p "..."
--model claude-haiku-4-5-20251001 --permission-mode bypassPermissions`) once a day (off-peak,
local time), with its working directory pinned to this hub root. The prompt addresses
Architect by name and directs it to run the `dreaming` skill's end-of-day consolidation —
a bare, unaddressed `"Good night Team"` does not reliably trigger the skill in a cold,
non-interactive session, so the registered prompt is more explicit
than what you'd normally type by hand at the end of an interactive session; the task exists
so consolidation doesn't depend on remembering to trigger it at all. `--permission-mode
bypassPermissions` is required because consolidation is all file-writing tool calls and
nobody is present overnight to approve a permission prompt. This does not appear on
macOS/Linux (Mac/Linux support is deferred to a future release).

- **Opt-in, not default-on.** Declining (or pressing Enter, since the default answer is No)
  skips registration entirely — setup still completes normally either way.
- **Turning it off again:**
  ```powershell
  npm run setup -- --disable-nightly-dreaming
  ```
  Removes the registered Scheduled Task (if any) without running the rest of the interactive
  wizard, and updates `workspace.config.json` so a future `npm run setup` re-run won't
  re-offer it as already-enabled. You can also decline it directly the next time `npm run
  setup` prompts you.
- **Retroactive offer for existing hubs:** if your hub was set up before this shipped, `npm
  run doctor` surfaces a warning with a hint to re-run `npm run setup` and opt in.

### Check hub health

```powershell
npm run doctor
```

Runs a battery of checks against the hub (config files, `.mcp.json`, agent profiles, relay wiring if enabled, etc.) and prints a pass/fail/warn report. Missing `memory/<agent>.md` files are scaffolded automatically in the same run — the required agent list is derived from whatever agent profiles are actually deployed under `.claude/agents/`, so doctor never invents memory files for agents that aren't installed in this hub. Existing memory files are never touched.

**`.gitattributes` check (check 3):** doctor verifies the hub's `.gitattributes` declares `tools/*.sh eol=lf` and `tools/*.txt eol=lf`, in addition to the existing `merge=ours` personalization entries. These rules force the shell scripts under `tools/` to stay LF-terminated even on a Windows checkout with `core.autocrlf=true` — without them, git's checkout-time normalization injects `\r` bytes that break `set -euo pipefail` and other bash syntax. If your hub was deployed before this rule existed and already committed `tools/*.sh` with CRLF line endings, redeploying alone will not fix files already stored in git's object store with the wrong line endings — the `.gitattributes` rule only governs future checkouts. After redeploying (which updates `.gitattributes`), run `git add --renormalize .` once to rewrite the affected blobs back to LF, then commit the result.

**Nightly dreaming check (check 18, Windows only):** doctor never registers the Scheduled Task itself — every check that needs your consent for a side effect hints back at `npm run setup` rather than acting on its own. It warns with a "not configured" hint on hubs that predate this feature (see [Nightly dreaming](#nightly-dreaming-windows-only) above), skips cleanly when you've explicitly declined, passes when the task is confirmed registered, and warns on drift if `workspace.config.json` says it's enabled but the Scheduled Task is no longer actually registered (e.g. removed manually via Task Scheduler).

---

## Task file format

Task files are markdown with YAML front matter. The front matter tells Claude which agent, mode, model, and skills to load for the session.

```markdown
---
agent: builder
mode: engineering
model: claude-sonnet-4-6
status: state:ready-for-implementation
verifier: Tester
finding-id: tst-low-coverage
skills:
  - scan-tst
  - software-engineer-mode
  - ticket-lifecycle-mode
---

# Increase test coverage

**Project:** my-project
**Priority:** high

15 test files for 42 source files (36%). Target: ≥50% file coverage.

## Acceptance Criteria

- [ ] Test file ratio reaches 50%+
- [ ] All new tests cover happy path, edge cases, and failure cases
- [ ] No regressions introduced
```

---

## Agent memory

Memory files live in `memory/` (gitignored — local only):

```text
memory/
  architect.md    ← HOT / WARM / COLD memory for Architect
  builder.md
  tester.md
  router.md
  archive/        ← rotated memory snapshots
```

Agents read their memory file at session start and update it at session end. HOT items surface in the morning briefing. WARM items inform planning. COLD items are archived or dropped.

If a memory file goes missing (e.g. a fresh deploy, or a file deleted by accident), `npm run doctor` scaffolds it automatically the next time it runs — no extra flag or command needed. Files that already exist are left untouched.

---

## Where you stay in control

| Decision | Owner | Why |
| --- | --- | --- |
| Approve scope before work starts | You | Direction is yours |
| Auth, payments, migrations, secrets, infra | You | Never delegated |
| Final merge and close | You | No auto-merge exists |
| Third consecutive failure on a ticket | You | System parks, waits for your call |

Everything between "approved to start" and "ready to merge" runs autonomously. The gates at either end are yours.

---

## Ticket lifecycle

Work moves through defined states with role-based transition permissions:

| State | Owned by |
| --- | --- |
| `ready-for-implementation` | Architect / Technical Lead |
| `in-progress` | Builder |
| `ready-for-review` | Builder |
| `ready-for-qa` | Builder (after self-review) |
| `qa-passed` | Tester |
| closed / next direction | Team Lead (you) |

Tester produces PASS, FAIL, PARTIAL PASS, or BLOCKED — never skips the handoff payload check, never self-approves. Builder never declares QA done. You stay the final authority on merge and close.

---

## Release Versioning

The hub release version is tracked in the root `VERSION` file (semver).

**Check for updates:**
```
npm run version:check
```

Returns JSON `{"status": "up-to-date" | "update-available" | "offline", "local": "...", "remote": "..."}`.

**Bump the version:** Edit `VERSION` manually or via release-please. The deploy step automatically copies `VERSION` to the hub output root.

---

## Upgrade path

This free tier (`agistra.dev`) is the foundation. Three paid tiers build directly on top of it, each adding its own tech stack — no pricing or feature detail here, just what each tier technically adds.

### `agistra.dev:graph`

[![Graphify](https://img.shields.io/badge/Graphify-MIT-3776AB.svg)](https://github.com/Graphify-Labs/graphify)
[![uv](https://img.shields.io/badge/uv-managed_Python-DE5FE9.svg)](https://docs.astral.sh/uv/)

A one-time-purchase bundle: this free core with [Graphify](https://github.com/Graphify-Labs/graphify), an MIT-licensed codebase knowledge-graph tool, layered in. Graphify installs at setup time via [uv](https://docs.astral.sh/uv/), which manages its own private Python runtime — no separate Python install required. Code-only graph parsing needs no account or API key; an optional semantic-extraction layer can call your own Anthropic/OpenAI account.

### `agistra.dev:sub`

[![Obsidian](https://img.shields.io/badge/Obsidian-vault-7C3AED.svg)](https://obsidian.md)
[![qmd](https://img.shields.io/badge/qmd-MCP_retrieval-blue.svg)](https://www.npmjs.com/package/@tobilu/qmd)
[![Claude Code](https://img.shields.io/badge/Claude_Code-first--supported-blue.svg)](.claude/agents)

The same free agent system, with agent working state (memory, tasks, docs) relocated from repo files into an Obsidian vault, indexed and retrieved through `qmd`'s native MCP integration. Claude-first: you bring your own Claude Code subscription or API key.

### `agistra.dev:ops`

[![LangGraph](https://img.shields.io/badge/LangGraph-orchestration-1C3C3C.svg)](https://www.langchain.com/langgraph)
[![LangChain](https://img.shields.io/badge/LangChain-model_abstraction-1C3C3C.svg)](https://www.langchain.com)
[![Ollama](https://img.shields.io/badge/Ollama-model_provider-000000.svg)](https://ollama.com)
[![n8n](https://img.shields.io/badge/n8n-automation_shell-EA4B71.svg)](https://n8n.io)
[![Telegram](https://img.shields.io/badge/Telegram-control_surface-26A5E4.svg)](https://telegram.org)

A full superset of `agistra.dev:sub`'s Obsidian + qmd storage stack, plus a LangGraph runtime orchestration layer, LangChain for multi-provider model abstraction (Claude, plus Ollama-hosted models), Ollama as a model provider, n8n as an outer automation shell, and Telegram as a control surface.

---

## Open source

Agistra is open source and free to use.

**[github.com/vsetchinfc/agistra.dev](https://github.com/vsetchinfc/agistra.dev)**

Clone it, deploy it to your own hub, and run your team from there. The source of truth for agent profiles, skills, and the CLI lives in the profiles repo — deploy generates your hub from it.

Pull requests and issues welcome.
