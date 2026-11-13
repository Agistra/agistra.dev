# AI/LLM Risks (slug: `ai-llm`)

Load this when the target contains agent prompts, tool wiring, model calls, or memory and log
handling for an agent. The Evidence Discipline and Output Format in `SKILL.md` apply unchanged.

## What to look for

- Untrusted text reaching a model as instructions: fetched pages, file contents, tool results,
  issue or ticket bodies, and subagent hand-backs placed in a prompt with no marker saying they are
  data.
- Authority wider than the task needs: an agent holding write, shell, network, or credential tools
  it never uses, or one tool that does more than its stated purpose.
- Secrets in prompts, memory files, transcripts, or logs: keys pasted into a system prompt, tokens
  echoed by a tool and then stored, full prompts written to logs.
- Model output used as an instruction to a machine: output passed to a shell, an interpreter, a
  query, a file path, or a deploy step with no allow-list or human check between them.
- An action with outside effects (send, publish, delete, spend) that runs on model output alone.

## What counts as evidence

- The prompt template or call site quoted, showing where the untrusted value enters and that nothing
  separates or checks it.
- The tool definition or permission list quoted, plus the task text showing the extra authority is
  unused.
- The line where model output reaches the sink, quoted from the code.

## What does not count

- Prompt wording you consider weak, with no path for untrusted text to reach it.
- A tool that is broad but only reachable from a trusted, human-written prompt.
- Model output that is only displayed or logged without secrets.
- A hypothetical jailbreak. Without a quoted entry path it is an open question.

## Verdict rules

A finding needs a location and quoted evidence. A missing second layer (for example no output filter
when the tool already runs with least privilege) is a hardening note, not a vulnerability. If the
outcome turns on a fact you cannot read, such as which tools a deployed agent is granted, give it
the needs-validation verdict with a read-only way to settle it.
