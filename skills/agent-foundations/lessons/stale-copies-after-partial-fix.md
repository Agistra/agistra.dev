Supports law: Verify Before Reporting (VBR) — Duplicate-content check.

# Stale copies survived a partial fix

The Working Directory Verification probe path was copy-pasted into five places (one shared skill + four `SOUL.md` files). A PR rework fixed only the shared skill; Architect's review confirmed the new adapter table was correct and approved — but never grepped for the old hardcoded `attempt to read \`.claude/agents/<name>.md\`` line, so four stale copies survived into the merged commit. The team lead caught it on second review.

The fix is one grep before reporting complete: `grep -rn "<old pattern>" .` — if it returns hits, the job is not done.

Script candidate: this reduces to a mechanical check (grep the whole repo for the old pattern and fail on any hit) and could become a script.
