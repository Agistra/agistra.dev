---
name: browser-automation
description: "Use when: Tester needs UI state evidence for VBR, or Builder needs to verify an integration wire is observable end-to-end. Powered by agent-browser MCP — token-efficient browser automation (200–400 tokens/page)."
argument-hint: "URL to verify, UI state to capture, form to fill, or integration endpoint to exercise"
---

# Browser Automation

Token-efficient browser automation via the `agent-browser` MCP server. Provides Tester with evidence-grade UI verification and gives Builder a lightweight end-to-end integration check.

## When to Load

**Tester:** Load when the acceptance criteria include a visible UI state, a rendered page, a form interaction, or a URL that must be reachable. VBR for Tester requires observable evidence — a screenshot or captured text, not just a passing test suite.

**Builder:** Load when the ticket's end-to-end step requires confirming that a new integration wire produces observable output in a running app. Tests passing is not sufficient when the integration surface is a rendered page or API response visible in a browser.

Do not load for: unit tests, static file checks, pure API responses verified via curl/fetch, or any task where the acceptance criteria make no reference to UI state or browser-visible output.

## VBR Criteria When Browser Is Available

Tester must satisfy at least one of these before reporting `state:qa-passed`:

- Screenshot captured showing the expected UI state (visible text, rendered component, or error state)
- Page text extracted confirming the expected content is present
- Navigation succeeded to the target URL without error (HTTP 2xx or expected redirect)
- Form submission completed and confirmation state is visible

"Tests pass" alone does not satisfy VBR when browser verification is available and the ACs reference UI state.

## Usage

**Preflight:** Before using any `mcp__agent-browser__*` tool, confirm two things, not just one: (1) the server is present in `.mcp.json` and reachable, and (2) the current subagent's own tool grant (`claude.tools` in `agent.manifest.json`, or the equivalent `tools:` frontmatter) actually lists the specific `mcp__agent-browser__*` tool names needed. `.mcp.json` configuration makes the server reachable session-wide, but it does not by itself grant any subagent access to it — Claude Code's subagent `tools:` allowlist does not support a wildcard for MCP tools (individual restricted-content gates aside), so every tool name must be explicitly enumerated in the subagent's own manifest. If either check fails, fall back immediately to the When Browser Is Unavailable section below and report evidence quality in your verdict.

**Windows cold-start hang — warm the daemon first (mandatory on Windows).** On Windows the MCP server can wedge forever on the first call that has to start the browser daemon (typically `agent_browser_open`): the browser launches and the page loads, but the tool never returns, the tool's own `timeoutMs` is not honored, and every later call from that MCP server queues behind it. Cause: the detached daemon inherits the pipes the MCP server is reading, so the server never sees end-of-output (upstream bug, unfixed as of agent-browser 0.38.1: https://github.com/vercel-labs/agent-browser/issues/1407). Once the daemon is already running, MCP calls return in about a second. So, before the first `mcp__agent-browser__*` call in a session:

1. Start the daemon with the one-shot CLI, run plainly (not inside `$(...)`, a pipe, or other output capture, which hang the same way): `timeout 60 npx agent-browser open about:blank`. If the MCP calls use a named session or namespace, pass the same `--session`/`--namespace` here.
2. Then make the MCP calls. Treat any MCP call that has not returned within about 30 seconds as the hang: do not retry it (retries queue behind the wedged call) and do not wait it out. Use the CLI for the rest of the run (`npx agent-browser open <url>`, `npx agent-browser screenshot <path>`, `npx agent-browser close`) and record the fallback in your evidence.
3. A wedged MCP server only recovers when the client session restarts. Running `npx agent-browser close` (matching session/namespace) also releases a stuck caller.

Once both preflight conditions and the warm-up are met, the `agent-browser` MCP server exposes tools directly in the session. No `npx` invocation is needed for the tool calls themselves — tools are available as `mcp__agent-browser__agent_browser_open`, `mcp__agent-browser__agent_browser_snapshot`, `mcp__agent-browser__agent_browser_screenshot`, `mcp__agent-browser__agent_browser_click`, `mcp__agent-browser__agent_browser_fill`, `mcp__agent-browser__agent_browser_get_text`, etc. — see the full enumerated `core`-profile tool list in Tester's or Builder's `agent.manifest.json`.

Common operations:
- Navigate to a URL and capture a screenshot
- Extract visible text from a page
- Click a button or link by label
- Fill and submit a form

## Token Budget

agent-browser represents each page in 200–400 tokens — roughly 10–20× cheaper than raw Playwright output. This makes it viable to run a browser check on every QA pass without a significant context cost.

Keep browser sessions short: navigate → capture evidence → close. Do not leave sessions open across multiple tool calls.

## Native Browser and Computer-Use Tools

The `agent-browser` MCP server is the default path for routine per-ticket VBR evidence on every adapter — this does not change. It is adapter-independent (our own MCP server, configured identically via `.mcp.json` on Claude Code, Codex, Cursor, and Copilot) and its 200–400 token/page cost is the reason the skill was standardised around it.

Two adapters ship a heavier native browser/screen-automation capability:

- **Claude Code** — `claude-in-chrome` (native browser automation, full interactive control)
- **Codex** — `computer-use` (screen automation via `~/.codex/computer-use/config.json`)

Both are supplementary options, not replacements. Use them only when `agent-browser` genuinely cannot do the job:

- Visual or interactive judgment calls where `agent-browser`'s text/screenshot extraction is insufficient — e.g. verifying a CSS animation, drag-and-drop flow, or canvas rendering that requires real browser interactivity.
- GIF or screen recording production for a human-facing demo.

Do not treat these as general-purpose alternatives to `agent-browser` for routine QA evidence. The token-efficiency rationale for `agent-browser` applies on every ticket; the native tools are the exception.

## When Browser Is Unavailable

If the MCP server is not running or not configured, fall back to:
- `curl` for HTTP reachability checks
- Reading rendered HTML files from the build output
- Manual screenshot instruction to the team lead

**VBR fallback rule:** If the acceptance criteria explicitly require browser evidence (UI state, visual confirmation, form submission feedback, etc.), and only curl or static file fallbacks were used, report the result as **BLOCKED** — evidence is insufficient to satisfy VBR without observable UI state capture. Note the fallback method in the QA report and escalate to the team lead for manual verification.

Note the fallback method in the QA report so the team lead can assess evidence quality.
