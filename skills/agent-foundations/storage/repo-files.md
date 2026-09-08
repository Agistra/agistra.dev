# repo-files Storage Plugin

This file is the `repo-files` implementation of the storage plugin contract defined in
`agent-foundations/SKILL.md` (Storage Plugin Contract section). It formalizes the
current free-tier behavior — all storage is plain Markdown files in the repository.
No behavior change from this ticket; this is an extraction of existing mechanics into
an explicit, pluggable form.

The vault-backed plugin used by other tiers covers the paid-tier implementation.

## Plugin Identity

- **Plugin name:** `repo-files`
- **Tier:** `dev` (free tier) and any repo-file-backed hub
- **Tooling required:** standard file I/O (Read/Edit/Write tools, or equivalent)

---

## Memory store

### read-memory(agent)

Read `memory/<agent>.md` from the hub root.

Example: `memory/builder.md`, `memory/architect.md`.

### list-memory-agents()

List the `.md` files directly under `memory/` (top-level only, non-recursive).
Excludes `memory/archive/` (a subdirectory, not an agent file) and non-agent files
such as `memory/working-buffer.md`. Each remaining filename, minus the `.md`
extension, is an agent id (e.g. `architect`, `builder`, `router`, `tester`). Supports
tooling such as the memory-index CLI, which must enumerate every agent's memory
file rather than read one known agent at a time.

### write-memory-entry(agent, tier, content)

Edit the HOT, WARM, or COLD section of `memory/<agent>.md`. The tier argument
identifies which section heading to target. Prepend new HOT entries (most recent
first); append WARM/COLD entries at the bottom of the relevant section.

### archive-memory(agent, date)

Write the archived snapshot to `memory/archive/<agent>-YYYY-MM-DD.md`. The date
argument is formatted `YYYY-MM-DD`. The dreaming skill calls this at the end of each
consolidation cycle before compacting the live file.

### compact-memory(agent, newContent)

Rewrite `memory/<agent>.md` with the compacted content. The dreaming skill supplies
the full new file content after distilling HOT→WARM→COLD decay. This is a full
overwrite, not an append.

---

## Task store

Task files live at `projects/<project>/task_<id>_<state>_<slug>.md`.

The filename infix `<state>` is the derived index of `status:` frontmatter; the
`status:` field is authoritative. The CLI reconciles the infix with
frontmatter on every transition (`check:tickets` / `fix:tickets`).

### create-task(project, id, frontmatter, body)

Write a new file at `projects/<project>/task_<id>_<state>_<slug>.md`, where
`<state>` is the value of the `status:` field in frontmatter and `<slug>` is a
short kebab-case description derived from the ticket title. Include the full YAML
frontmatter block followed by the task body.

Required frontmatter fields: `status`, `verifier`. Optional: `fail-count`, `parked`,
`github-issue` (or the active tracker plugin's reference field), `agent`, `model`,
`skills`, `token-budget`.

### read-task(id)

Glob `projects/**/*task_<id>_*.md` and read the matching file. State is read from
the `status:` frontmatter field (authoritative); the filename infix is a derived
convenience index only.

### list-tasks(project, stateFilter)

Glob `projects/<project>/task_*.md`. If `stateFilter` is provided, filter by the
`status:` frontmatter field value. Return the matching file paths and their `status:`
values.

### update-task-fields(id, fields)

Edit the YAML frontmatter of the task file identified by `id`. The `fields` argument
is a map of frontmatter key→value pairs to update. Do not rename the file from this
operation — use `transition-state` when a rename is required.

### transition-state(id, newState)

1. Edit the `status:` frontmatter field to `newState`.
2. Rename the file to replace the `<state>` infix with the new state token.
   The state-to-filename-token mapping:
   - `state:ready-for-implementation` → `ready-for-implementation`
   - `state:in-progress` → `in-progress`
   - `state:ready-for-review` → `ready-for-review`
   - `state:ready-for-qa` → `ready-for-qa`
   - `state:changes-requested` → `changes-requested`
   - `state:qa-passed` → `qa-passed`
   - `closed` → `done`
3. The CLI (`check:tickets` / `fix:tickets`) reconciles filename infix with
   `status:` frontmatter for any file the agent edits but does not rename.

### append-task-section(id, section, content)

Append `content` under the named section heading in the task file (e.g. `## Log`,
`## QA Report`, `## Token Spend`). If the section heading does not exist, create it
at the end of the file before appending.

---

## Document store

Documents live in one of two places, depending on whether the collection is hub-wide
or project-scoped. There is no caller-supplied flag — `create-document`/`read-document`
resolve which one applies from the `collection` argument alone.

### Path resolution rule

- `collection` ∈ `{decisions, architecture, reports, proposals}` → **hub-wide**:
  `docs/<collection>/<name>`.
- Any other `collection` value → **project-scoped**: `projects/<collection>/docs/<name>`
  (the `collection` argument is the project id in this case). If `projects/<collection>/`
  does not yet exist (a brand-new project's first document), create it — never silently
  fall back to a hub-wide path.

`read-document` resolves by the identical rule.

### Filename convention

- **Hub-wide** (`docs/<collection>/<name>`): `<name>` includes the file extension, e.g.
  `ADR-NNN-foo.md`. No project-id prefix applies here — these collections aren't
  project-scoped.
- **Project-scoped** (`projects/<collection>/docs/<name>`): `<name>` is bare,
  kebab-case, and carries **no project-name prefix** — the project folder is already
  the namespace. Use `open-questions.md`, not `<project>-open-questions.md`.

### Evidence (re-verified against the live `agistra.dev-graph` hub)

| Path | Real content found | Interpretation |
| --- | --- | --- |
| `docs/decisions/` | 2 files following the `ADR-<n>-<slug>.md` pattern | Hub-wide collection, real usage confirmed |
| `docs/reports/` | 1 report (the handover doc for this exact fix — genuinely hub-wide content, not scoped to any one project) | Hub-wide collection, real usage confirmed |
| `docs/architecture/` | Does not exist on this hub | Hub-wide collection, documented but currently unused — kept, since a one-hub audit doesn't justify removing an available option |
| `docs/proposals/` | Does not exist on this hub | Hub-wide collection, documented but currently unused — kept, same reasoning as `architecture` |
| `projects/<project>/docs/` (present for 7 of 11 projects checked) | Every file found is bare kebab-case with no project-name prefix, e.g. `projects/<project>/docs/proj-stack.md`, `projects/<project>/docs/open-questions.md`, `projects/<project>/docs/lift-and-shift-plan.md` | Project-scoped rule and no-prefix filename convention confirmed across every project checked |

### create-document(collection, name, content)

Resolve the path per the rule above, then write a new file at the resolved path. The
`name` argument includes the file extension. Create the containing directory
(`docs/<collection>/` or `projects/<collection>/docs/`) if it does not already exist.

### read-document(collection, name)

Resolve the path per the identical rule, then read the file from the hub root.
