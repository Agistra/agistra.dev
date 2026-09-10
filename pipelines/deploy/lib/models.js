/**
 * Model resolution helpers — read agent manifests to get the correct model for each agent.
 *
 * Router always uses the economy-tier model (Haiku) regardless of platform defaults.
 * Architect, Builder, and Tester use Sonnet (the default Claude model).
 * This module provides the authoritative model lookup so auto-dispatch and doctor
 * always agree on the expected model rather than each maintaining its own constant.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROUTER_MANIFEST_REL = path.join('agents', 'profiles', 'router-workspace', 'agent.manifest.json');

/**
 * Read the Router model from the router-workspace manifest.
 *
 * When the manifest is absent and `hubRoot` is provided, falls back to reading the
 * model from the deployed profile at `hubRoot/.claude/agents/router.md` frontmatter.
 * Fails loudly (throws) only when both the manifest and the fallback profile are
 * missing or yield no model.
 *
 * @param {string} profilesRoot  Absolute path to the setchin-agent-profiles repo root.
 * @param {typeof fs} [fsMod]    Injectable fs module for testing.
 * @param {string} [hubRoot]     Absolute hub root — used as fallback profile location.
 * @returns {string}  The model id, e.g. 'claude-haiku-4-5-20251001'.
 */
export function resolveRouterModel(profilesRoot, fsMod = fs, hubRoot) {
	const manifestPath = path.join(profilesRoot, ROUTER_MANIFEST_REL);

	if (!fsMod.existsSync(manifestPath)) {
		// Manifest absent — attempt fallback to deployed router profile.
		if (hubRoot) {
			const profilePath = path.join(hubRoot, '.claude', 'agents', 'router.md');
			if (fsMod.existsSync(profilePath)) {
				const content = fsMod.readFileSync(profilePath, 'utf-8');
				const model = parseProfileModel(content);
				if (model) return model;
			}
		}
		throw new Error(
			`Router manifest not found: ${manifestPath}\n` +
			'Run from the setchin-agent-profiles repo root.',
		);
	}

	let manifest;
	try {
		manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf-8'));
	} catch {
		throw new Error(`Router manifest is not valid JSON: ${manifestPath}`);
	}

	const model = manifest?.claude?.model;
	if (!model) {
		throw new Error(
			`claude.model missing in router manifest: ${manifestPath}\n` +
			'Add "claude": { "model": "claude-haiku-..." } to the manifest.',
		);
	}

	return model;
}

/**
 * Parse the model field from an agent profile frontmatter string.
 * Returns null when the field is absent or unparseable.
 *
 * @param {string} content  Full text of a .md agent profile.
 * @returns {string | null}
 */
export function parseProfileModel(content) {
	const match = (content ?? '').match(/^---[\s\S]*?^model:\s*(\S+)/m);
	return match ? match[1] : null;
}

/**
 * Adapter-specific capability map for subagent-dispatch model selection appearing in
 * profile prose (e.g. ROUTING.md's "Dispatch Builder" model-selection table). Each
 * adapter's own subagent/task-dispatch mechanism (if any) exposes different model
 * identifiers than Claude Code's Agent tool `model` parameter (`sonnet`/`opus`/`haiku`/
 * `fable`). Silently forwarding those Claude-specific aliases into another adapter's
 * generated instructions asks that runtime for a model it doesn't have — the defect
 * this map exists to close (compose-codex.js previously inlined ROUTING.md unchanged).
 *
 * `fast` = an economy-tier / low-latency model for simple, low-risk dispatch work.
 * `capable` = a fuller-reasoning model for complex, multi-file, or high-ambiguity work.
 *
 * `null` means "no confirmed adapter-native identifier" — callers fall back to
 * adapter-neutral prose (see `resolveDispatchModelText`) describing the capability
 * tier instead of asserting a specific, possibly nonexistent, model name. Only Claude
 * Code's Agent tool aliases are confirmed today; Cursor, Codex, and GitHub Copilot each
 * have their own (or no) subagent-dispatch mechanism and none is confirmed to accept
 * these same short aliases.
 */
export const ADAPTER_DISPATCH_MODELS = {
	claude: { fast: 'haiku', capable: 'sonnet' },
	cursor: { fast: null, capable: null },
	codex: { fast: null, capable: null },
	copilot: { fast: null, capable: null },
};

const DISPATCH_MODEL_FALLBACK_TEXT = {
	fast: "your runtime's fastest/economy-tier model",
	capable: "your runtime's most capable reasoning model",
};

/**
 * Resolve the literal replacement text for a `{{DISPATCH_MODEL_FAST}}` /
 * `{{DISPATCH_MODEL_CAPABLE}}` placeholder token for a given adapter.
 * Returns a backtick-quoted model identifier when the adapter has a confirmed one
 * (matching how the source prose already formats literal model names), or
 * adapter-neutral fallback prose otherwise — including for adapter names this map
 * doesn't recognise.
 *
 * @param {string} adapter  One of 'claude' | 'cursor' | 'codex' | 'copilot'.
 * @param {'fast'|'capable'} tier
 * @returns {string}
 */
export function resolveDispatchModelText(adapter, tier) {
	const literal = ADAPTER_DISPATCH_MODELS[adapter]?.[tier];
	return literal ? `\`${literal}\`` : DISPATCH_MODEL_FALLBACK_TEXT[tier];
}

/**
 * Substitute `{{DISPATCH_MODEL_FAST}}` / `{{DISPATCH_MODEL_CAPABLE}}` placeholder
 * tokens in profile source content (e.g. ROUTING.md) with adapter-appropriate text.
 * A no-op when the content contains neither token.
 *
 * @param {string} content
 * @param {string} adapter
 * @returns {string}
 */
export function substituteDispatchModelTokens(content, adapter) {
	if (typeof content !== 'string' || content.indexOf('{{DISPATCH_MODEL_') === -1) return content;
	return content
		.replace(/\{\{DISPATCH_MODEL_FAST\}\}/g, resolveDispatchModelText(adapter, 'fast'))
		.replace(/\{\{DISPATCH_MODEL_CAPABLE\}\}/g, resolveDispatchModelText(adapter, 'capable'));
}
