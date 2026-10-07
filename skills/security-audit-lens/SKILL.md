---
name: security-audit-lens
description: "Use when: a general codebase assessment, pre-migration/pre-rewrite review, feasibility question about converting/migrating/rewriting a codebase (how hard, effort), or explicit security-focused request needs a structured, repeatable security audit pass covering hardcoded secrets, injection-prone constructs, auth/debug backdoors, insecure config defaults, and weak credential storage. Complements (does not replace) the built-in /security-review command. Not a mandatory gate on every ticket."
argument-hint: "Codebase, module, config set, or diff to audit for security findings"
---

# Security Audit Lens

Use this skill as a stack-agnostic security review methodology. It does not replace Claude Code's
built-in `/security-review` command, and it does not wrap a SAST or dependency scanner. It is a
repeatable, LLM-driven review pass that produces structured, evidence-backed findings — usable
standalone on a full read-only codebase, or as one step inside a larger assessment.

`/security-review` is scoped to the pending changeset on the current branch. This skill covers a
wider surface: it can run against an entire codebase with no pending diff, be invoked before
migration or rewrite planning, or be layered on top of `/security-review`'s output to add
structured severity, location, and remediation fields that the built-in command does not produce.

Nothing in this skill assumes a specific language, framework, database, or hosting platform. No
framework-specific example code is baked into the trigger logic or checklist below — categories are
named generically; the finding itself supplies the concrete evidence from the actual codebase under
review.

## When to Load

Load this skill when the work involves any of the following:

- a general codebase assessment (e.g. an intake or health-check pass on an unfamiliar codebase)
- preparation before migration, rewrite, or major refactor planning
- an explicit request for a security-focused review, on request from the team lead or a ticket
- a full read-only review where no pending diff exists for `/security-review` to scope against

Do not treat this as a mandatory gate on every ticket. Invoke it when the work touches
authentication, secrets, external input handling, or when a full assessment is already underway.
Routine tickets that do not touch these areas do not need this skill.

## Relationship to `/security-review`

- `/security-review` reviews the pending diff on the current branch; it is fast and change-scoped.
- This skill can run standalone with no diff (a full codebase pass), before a diff exists (pre-migration
  planning), or alongside `/security-review` to convert its output into the structured format below.
- Use both together on a normal PR: run `/security-review` for the changeset, then use this skill's
  checklist and output format to file any finding that needs to travel with the ticket or assessment
  doc.

## Evidence Discipline (Read First)

A security skill that invents a vulnerability that does not exist is worse than one that misses a
real one — a false Critical finding burns trust and wastes remediation effort on nothing. Apply the
same evidence discipline as VBR:

- Every finding must cite the actual file path and line number (or the smallest locatable unit —
  function, config key, endpoint) where the evidence was observed. No finding without a location.
- Do not report a finding from a framework's known-bad-pattern list unless you have actually read
  the code or config in question and can quote it.
- If you suspect a class of issue but have not located concrete evidence (e.g. "there's probably a
  secret somewhere in config" without having found one), do not report it as a finding. Either keep
  looking or report it as an open question in the audit summary, not as a finding.
- Prefer under-reporting with an explicit "not fully covered" note over over-reporting with
  low-confidence guesses.
- Reuse the Confidence Tiers from `code-review-and-quality`: **Confirmed** (the exact string or
  pattern was read directly), **Likely** (a known-bad shape observed with a specific counter-example,
  but not exercised), **Speculative** (inferred without a direct quote — report only at
  Critical/Required severity, tagged `(unconfirmed)`, never at Nit/Optional/FYI).

## Checklist Categories

These categories are stack-agnostic. Adapt the concrete search to whatever language, framework, and
config format the target codebase actually uses — do not assume any one of them.

### 1. Hardcoded Credentials and Secrets

Search committed files (source, config, scripts, infra-as-code, CI pipeline definitions) for:

- literal passwords, API keys, connection strings, or tokens embedded in code or config
- credentials committed in plaintext config files that should be sourced from environment variables
  or a secrets manager
- private keys, certificates, or signing material checked into the repository
- secrets present in commit history even if removed from the current working tree (flag for
  follow-up; a full history scan is out of scope for this pass unless explicitly requested)

### 2. Injection-Prone Constructs

Search for user- or external-input-influenced values reaching a sensitive sink without
parameterization or sanitization:

- query or command construction built via string concatenation or interpolation of external input
  (database queries, shell commands, file paths, dynamic code evaluation, LDAP/XML/template queries)
- external input reaching a sink (rendering, logging, deserialization) without an intervening
  validation or encoding step
- stored procedure or ORM calls that bypass parameter binding in favor of raw string assembly

### 3. Auth and Debug Backdoors

Search for code paths that bypass, weaken, or short-circuit normal authentication or authorization:

- debug flags, environment checks, or query parameters that grant elevated access, impersonation, or
  bypass when set
- hardcoded backdoor accounts, master passwords, or "skip auth for testing" branches left reachable
  in non-test code paths
- authorization checks that can be disabled by a client-controlled value (header, cookie, query
  string, request body) rather than a trusted server-side source
- commented-out or feature-flagged auth checks that are effectively always disabled

### 4. Insecure Config Defaults

Search configuration files, infrastructure definitions, and startup code for:

- defaults that ship a feature open, permissive, or verbose when it should default closed, scoped,
  or quiet (e.g. wide-open CORS, verbose error pages/stack traces exposed to end users, permissive
  file upload types, debug mode left on)
- missing or weak transport security defaults (unencrypted connections allowed where encrypted
  should be required)
- default or well-known credentials shipped in example/seed config that is also used in real
  environments
- overly broad permission grants (file system, database, cloud IAM) used as the default rather than
  least privilege

### 5. Weak Credential Storage

Search for how stored user credentials are protected (distinct from category 1, which finds secrets committed to the repository):

- stored user credentials protected by reversible encryption instead of a salted slow hash
- hardcoded or config-held encryption keys and IVs used to protect stored credentials
- fast or unsalted hashes (MD5, SHA-1, plain SHA-256) used for passwords
- password material round-tripped to the client, or held in page or session state

## Output Format

Findings are structured records, not free prose. Reuse the Critical/Required/Nit/Optional/FYI
severity vocabulary from `code-review-and-quality` so findings from this skill sit consistently
alongside code review output.

```markdown
## Security Audit Findings

| # | Category | Location | Description | Severity | Confidence | Remediation direction |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [hardcoded-credentials / injection / auth-backdoor / insecure-config-default / weak-credential-storage] | [file:line] | [what was observed, quoted] | [Critical/Required/Nit/Optional/FYI] | [Confirmed/Likely/Speculative] | [what direction fixes it, not a full patch] |
```

Run each confirmed finding through `pattern-sweep` before listing it as final.

Severity definitions (reused verbatim from `code-review-and-quality`):

| Label | Definition |
|-------|------------|
| **Critical** | Blocks merge or requires immediate remediation. Live secret, exploitable injection, or an active auth bypass. |
| **Required** | Must be addressed before this class of risk ships further. Not actively exploited but a clear weakness. |
| **Nit** | Minor hardening opportunity. Author may deprioritize. |
| **Optional** / **Consider** | Worth considering, not required. |
| **FYI** | Informational only — context for future reference, no action required. |

Close every audit pass with a short summary block, even when findings are zero:

```markdown
## Audit Summary

- Scope: [what was actually reviewed — paths, modules, or "full repository"]
- Categories covered: [which of the five checklist categories were actually searched]
- Categories not covered / out of scope this pass: [name them explicitly, do not silently omit]
- Open questions: [suspected issues without located evidence — not reported as findings]
```

## What This Skill Does Not Do

- It does not replace `/security-review` — use both together when a pending diff exists.
- It does not run or wrap an automated SAST or dependency-scanning tool; it is an LLM-driven review
  methodology, not a scanner integration.
- It does not assume or bake in any framework-specific example code.
- It is not a mandatory gate on every ticket — invoke it when the work touches auth, secrets,
  external input, or a full assessment is underway.
- It does not report a finding without a concrete file/line citation; see Evidence Discipline above.

## Relationship to Other Skills

- `code-review-and-quality` — its Security axis (axis 4) covers security concerns found during a
  normal code review; this skill is the deeper, standing methodology for a dedicated security pass,
  and both reuse the same severity vocabulary so findings compose cleanly.
- `skill-quality-review` applies when editing this skill.
- `architecture-mode` — load this skill during a general codebase assessment or before
  migration/rewrite planning, per the "When to Load" section above.
