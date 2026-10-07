/**
 * secret-scan.hooks-plugin.js — PreToolUse hook wiring for the shared
 * secret-scanner gate on direct `Edit`/`Write` tool calls (the third of
 * three enforcement points using the shared scanner — packages/vault/
 * vault-guard.cjs and pipelines/deploy/lib/task-cli.js cover the other two
 * application-layer write paths).
 *
 * Ships to EVERY hub tier (dev, dev:graph, dev:sub, ops), unlike
 * graph-lens.hooks-plugin.js's Graphify-only gating: free-tier hubs have no
 * application-layer write guard in front of `Edit`/`Write` at all, and
 * vault-tier hubs still need this hook to backstop the documented MCP-down
 * direct-Edit fallback path (storage/obsidian.md).
 *
 * The runtime enforcement logic lives in secret-scan-gate.js — a separate
 * file, since it must ship *into* the deployed hub for the hook command to
 * actually run at session time, unlike this plugin file, which is
 * source-repo deploy tooling only. Mirrors graph-lens.hooks-plugin.js /
 * qmd.hooks-plugin.js's own command-vs-plugin split.
 *
 * Cursor/Codex/Copilot equivalents: checked at implementation time and none
 * exist. Cursor's own hook wiring in this hub (compose target:
 * pipelines/deploy/targets/cursor.js, template
 * templates/cursor-rules/hooks.json) only defines a `stop` hook (the WAL
 * memory-check adapter) — no `PreToolUse`-equivalent "before file edit" hook
 * type is wired anywhere in this codebase today. Copilot's own hook wiring
 * (pipelines/deploy/targets/vscode.js, templates/copilot/hooks/agent-stop.json)
 * is likewise `agentStop`-only. Codex has no hooks-plugin wiring at all in
 * this codebase. This mirrors exactly graph-lens's own scope (Claude-Code-
 * only) — equivalent wiring for the Cursor/Codex/Copilot adapters is
 * therefore a known, explicit gap on those three adapters until (if ever)
 * they ship an equivalent pre-write hook mechanism this plugin could target;
 * it is not silently assumed away — see the PR description for this change.
 */

import { upsertOwnedHook, hookHaystack } from './claude-hooks.js';

/**
 * Command run on every Edit/Write call to scan the write content for
 * high-confidence secret patterns, in exec form — see
 * GRAPH_LENS_PRE_TOOL_USE_ARGS's doc comment in graph-lens.hooks-plugin.js
 * for why exec form (bypassing shell interpretation) is required.
 * ${CLAUDE_PROJECT_DIR} is anchored for the same reason as
 * RELAY_SESSION_START_COMMAND / GRAPH_LENS_PRE_TOOL_USE_COMMAND: Claude Code
 * does not guarantee a hook's working directory is the project root.
 */
export const SECRET_SCAN_PRE_TOOL_USE_COMMAND = 'node';
export const SECRET_SCAN_PRE_TOOL_USE_ARGS = ['${CLAUDE_PROJECT_DIR}/pipelines/deploy/lib/secret-scan-gate.js'];

/** PreToolUse matcher: gates both Edit and Write calls. */
export const SECRET_SCAN_PRE_TOOL_USE_MATCHER = 'Edit|Write';

/**
 * Ensure hub .claude/settings.json includes PreToolUse → secret-scan-gate.js
 * for Edit/Write. Idempotent — skips if the hook is already present. Mirrors
 * mergeGraphLensPreToolUseHook's own idempotent-merge shape exactly
 * (graph-lens.hooks-plugin.js), including the two-part substring check
 * rationale documented there (exec form splits the script path and any
 * arguments across separate `args` array elements).
 *
 * @param {object} settings
 * @returns {object}
 */
export function mergeSecretScanPreToolUseHook(settings = {}) {
	return upsertOwnedHook(
		settings,
		'PreToolUse',
		h => hookHaystack(h).some(s => s.includes('secret-scan-gate.js')),
		{
			matcher: SECRET_SCAN_PRE_TOOL_USE_MATCHER,
			hooks: [{ type: 'command', command: SECRET_SCAN_PRE_TOOL_USE_COMMAND, args: SECRET_SCAN_PRE_TOOL_USE_ARGS }],
		},
	);
}
