# Supply Chain and CI (slug: `supply-chain-ci`)

Load this when the target contains CI workflow files, dependency manifests or lockfiles, container
definitions, or install scripts. The Evidence Discipline and Output Format in `SKILL.md` apply
unchanged.

## What to look for

- Unpinned references: a package run through `npx` or a similar runner with no version, an action
  or reusable workflow pinned to a moving tag or branch, an image taken by a floating tag.
- Workflows that run code from an untrusted source (a fork's pull request, a branch name, a PR title
  or body) in a job that can read secrets or write to the repository.
- Untrusted event data interpolated straight into a shell step.
- Lockfile drift: a manifest and its lockfile that disagree, a lockfile missing for a shipped app,
  or installs that ignore the lockfile.
- Production dependencies with a published advisory, when an advisory source was actually read.
- Install and lifecycle scripts (`preinstall`, `postinstall`, `prepare`) that fetch or run remote
  code, and dependencies pulled from a raw URL or an unreviewed git ref.
- Workflow tokens with write scope broader than the job needs.

## What counts as evidence

- The workflow, manifest, or script line quoted, with the trigger event shown for CI findings.
- For drift, the two files and the mismatching entry.
- For an advisory, the package, the installed version, and the advisory identifier you read.

## What does not count

- A floating tag on a job that has no secrets and cannot write anywhere.
- An unpinned development-only tool that never runs in CI or release.
- A version range in a manifest when the lockfile pins it and installs honor the lockfile.
- A package you merely dislike. Without an advisory or a quoted behaviour it is not a finding.

## Verdict rules

A finding needs a location and quoted evidence. A missing second layer, such as no pin on a step
whose job already holds read-only permissions and no secrets, is a hardening note, not a
vulnerability. If the outcome turns on a fact you cannot read, such as repository-level secret or
branch-protection settings, list it under Needs validation with a read-only way to settle it. Do not
run installs or call a registry to settle it.
