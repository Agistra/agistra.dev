/**
 * secret-scan.js — shared secret-pattern scanner enforcing the security
 * baseline's "no secrets in memory/task/report files" rule with real code,
 * not instruction alone.
 *
 * Single source of truth for the high-confidence secret-prefix pattern list
 * used at all three enforcement points this scanner backs:
 *
 *   1. packages/vault/vault-guard.cjs        — proxied MCP `tools/call` writes
 *   2. pipelines/deploy/lib/task-cli.js       — direct `fs.writeFileSync` writes
 *   3. pipelines/deploy/lib/secret-scan-gate.js — PreToolUse `Edit`/`Write` gate
 *
 * Ships unconditionally to every hub tier (dev, dev:graph, dev:sub, ops) —
 * see extras.js's copy list — because task-cli.js and secret-scan-gate.js
 * both ship to every tier, and vault-guard.cjs ships to dev:sub/ops.
 *
 * Pattern set: high-confidence secret-prefix patterns only (adapted from the
 * shape of gitleaks' MIT-licensed ruleset, not vendored) — deliberately no
 * generic entropy heuristics, to keep false positives rare.
 *
 * Deliberately has ZERO dependencies (no fs/path/etc.) — it is a pure string
 * scanner so it can be imported unchanged from an ESM caller (task-cli.js,
 * secret-scan-gate.js) or dynamically imported from a CommonJS caller
 * (vault-guard.cjs, which cannot `require()` this file directly because
 * package.json declares "type": "module").
 */

/**
 * @typedef {object} SecretPattern
 * @property {string} category  Human-readable category name shown in error
 *   messages — never the matched string itself (see scanForSecrets doc).
 * @property {RegExp} regex     Must NOT carry the sticky/global-with-shared-
 *   lastIndex footgun across calls — scanForSecrets resets lastIndex itself.
 */

/** @type {SecretPattern[]} */
export const SECRET_PATTERNS = [
	{ category: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/g },
	{ category: 'GitHub Token', regex: /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{36}\b/g },
	{ category: 'GitHub Fine-Grained Personal Access Token', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ category: 'Slack Token', regex: /\bxox[baprs]-[A-Za-z0-9-]+/g },
	{ category: 'PEM Private Key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
	{ category: 'Anthropic API Key', regex: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/g },
];

/**
 * Scan `content` for any high-confidence secret pattern. Returns the FIRST
 * match found (by pattern-list order, not necessarily by position in the
 * string) — a single hard block is sufficient; the caller does not need
 * every match to decide "reject this write".
 *
 * Never returns or logs the matched substring itself — only the category
 * name and the 1-based line number it occurred on. This is load-bearing: the
 * required behavior on a match is to name which pattern category matched and
 * where, without echoing the matched secret back — every call site
 * (vault-guard.cjs, task-cli.js, secret-scan-gate.js) relies on this function
 * never leaking the secret text into an error message, log line, or hook
 * output.
 *
 * @param {unknown} content  Content to scan. Non-string / empty input is
 *   treated as "nothing to scan" (returns null) rather than throwing — every
 *   call site passes already-string-coerced content, but this keeps the
 *   function defensively pure for any future caller.
 * @returns {{ category: string, line: number } | null}
 */
export function scanForSecrets(content) {
	if (typeof content !== 'string' || content.length === 0) return null;

	for (const { category, regex } of SECRET_PATTERNS) {
		// Reset lastIndex defensively: SECRET_PATTERNS' regexes carry the
		// global flag (for potential future multi-match use) but this
		// function only ever needs exec()'s first match, and a stale
		// lastIndex from a previous call against a *different* string could
		// otherwise skip a real match at the start of this one.
		regex.lastIndex = 0;
		const match = regex.exec(content);
		if (match) {
			const upToMatch = content.slice(0, match.index);
			const line = upToMatch.split('\n').length;
			return { category, line };
		}
	}

	return null;
}

/**
 * Build a consistent, non-echoing block-error message from a
 * `scanForSecrets()` match. Centralized here so every enforcement point
 * (vault-guard.cjs, task-cli.js, secret-scan-gate.js) reports the same shape
 * without duplicating the message string three times.
 *
 * @param {{ category: string, line: number }} match
 * @param {string} [locationOverride]  Custom location description (e.g.
 *   `field "content", line 3` — see vault-guard.cjs, which scans multiple
 *   named argument fields and needs to name which one matched). Defaults to
 *   `line <n>` when omitted, matching the plain single-content-string case
 *   (task-cli.js, secret-scan-gate.js).
 * @returns {string}
 */
export function formatSecretScanError(match, locationOverride) {
	const location = locationOverride ?? `line ${match.line}`;
	return `[secret-scan] Blocked: content matches the "${match.category}" pattern at ${location} — write rejected. Redact the secret and retry; the matched value is never echoed back.`;
}
