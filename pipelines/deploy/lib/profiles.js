import fs from 'node:fs';
import path from 'node:path';

const IDENTITY_FIELD_RE = /^-?\s*\*\*([^*:]+)\**\*\*[:\s]+(.*)/m;

/**
 * Parse a field value from an IDENTITY.md file.
 * Handles both `- **Label:** value` and `- **Label** value` (no colon) forms.
 */
export function parseIdentityField(content, label) {
	for (const line of content.split('\n')) {
		const match = line.match(/^-?\s*\*\*([^*:]+?)[*:]?\*\*[:\s]+(.*)/);
		if (match && match[1].trim().toLowerCase() === label.toLowerCase()) {
			return match[2].trim();
		}
		// Handle `- **Label** value` (no colon, label ends at **)
		const noColonMatch = line.match(/^-?\s*\*\*([^*]+?)\*\*\s+(.*)/);
		if (noColonMatch && noColonMatch[1].trim().toLowerCase() === label.toLowerCase()) {
			return noColonMatch[2].trim();
		}
	}
	return undefined;
}

/**
 * Read a file, returning undefined if it doesn't exist or cannot be read.
 */
export function readOptionalFile(filePath) {
	try {
		return fs.readFileSync(filePath, 'utf-8');
	} catch {
		return undefined;
	}
}

/**
 * Read and parse agent.manifest.json for a profile directory.
 * Returns undefined if the file is missing or unparseable.
 */
export function readAgentManifest(profileDir) {
	const filePath = path.join(profileDir, 'agent.manifest.json');
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch {
		return undefined;
	}
}

/**
 * Resolve the setchin-agent-profiles repo root from a `profilesRoot` directory
 * (`<repoRoot>/agents/profiles` — the shape every deploy target's own `profilesRoot`
 * argument already assumes; see `discoverProfileDirs`). Two levels up from
 * `profilesRoot` lands on the repo root, where `profiles.config.json` lives.
 */
function repoRootFromProfilesRoot(profilesRoot) {
	return path.resolve(profilesRoot, '..', '..');
}

/**
 * Read `profiles.config.json` from the repo root implied by `profilesRoot`.
 * Returns `{}` when the file is missing or unparseable — callers apply their own
 * fallback for whichever field they need, matching the existing "optional config,
 * optional field" behaviour of the rest of this module.
 *
 * @param {string} profilesRoot  Absolute path to the `agents/profiles` directory.
 * @returns {object}
 */
export function readProfilesConfig(profilesRoot) {
	const filePath = path.join(repoRootFromProfilesRoot(profilesRoot), 'profiles.config.json');
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch {
		return {};
	}
}

/**
 * Resolve the default model to fall back to when a manifest doesn't set its own
 * `claude.model` (or a per-target override, e.g. `cursor.model`). Reads
 * `defaults.model` from `profiles.config.json` at the repo root — the single place
 * to update for a bulk model-version upgrade across every agent that doesn't
 * declare its own override (see README's "Bulk model upgrade" section).
 *
 * This function is intentionally provider-agnostic — it only ever resolves the
 * literal anthropic-direct pin. A caller that needs provider-aware resolution
 * (e.g. a hub configured against a non-default model provider) wraps this
 * function rather than this function knowing about any specific provider; see
 * `resolveProviderAwareDefaultModel()` in `model-provider.js`. This module ships
 * unconditionally to every deployed hub tier (doctor.js imports it regardless of
 * hubType), so it must never carry any tier-specific provider's name, config
 * shape, or dead-code branch — see model-provider.js's own doc comment for the
 * disclosure-safety reasoning.
 *
 * @param {string} profilesRoot  Absolute path to the `agents/profiles` directory.
 * @returns {string|undefined}  The default model id, or `undefined` when
 *   `profiles.config.json` has no `defaults.model` set.
 */
export function resolveDefaultModel(profilesRoot) {
	const config = readProfilesConfig(profilesRoot);
	return config?.defaults?.model;
}

/**
 * Read the vscode-tools.json list for a profile directory.
 * Returns an empty array if the file is missing or malformed.
 */
export function readVSCodeToolList(profileDir) {
	const filePath = path.join(profileDir, 'vscode-tools.json');
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		if (!Array.isArray(parsed)) return [];
		return parsed.map(v => String(v).trim()).filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Normalise a single entry from a manifest's `skills` array into a consistent shape.
 *
 * Supports two declaration forms:
 *   - Plain string: "skill-name"                                     → guaranteed in-house skill
 *   - Object: { "name": "skill-name", "optional": true }              → optional, presence-gated skill
 *   - Object: { "name": "skill-name", "hubType": "dev:graph" }        → hub-type-gated skill, only
 *   - Object: { "name": "skill-name", "hubType": ["dev:graph", "dev:sub", "ops"] }
 *                                                                        bundled when the deploy's
 *                                                                        own hubType is a member of
 *                                                                        the declared set (the hub
 *                                                                        tiers form an upward ladder,
 *                                                                        not exact-match silos — a
 *                                                                        skill can be declared for
 *                                                                        several tiers at once)
 *   - Object: { "name": "skill-name", "hubType": [...], "requiresGraphify": true }
 *                                                                        additionally requires the
 *                                                                        deploy to have been run
 *                                                                        with `--with-graphify` for
 *                                                                        every hubType except
 *                                                                        `dev:graph` (which already
 *                                                                        ships Graphify-dependent
 *                                                                        skills unconditionally).
 *                                                                        Used for entitlement-gated
 *                                                                        skills that must not ship
 *                                                                        to a paid `dev:sub`/`ops`
 *                                                                        hub that hasn't purchased
 *                                                                        Graphify.
 *
 * The raw JSON `hubType` field accepts either a single string (author convenience for a skill
 * gated to exactly one tier) or an array of strings — both are normalised internally to an array
 * (or `undefined` if absent/malformed).
 *
 * `optional`, `hubType`, and `requiresGraphify` are independent, orthogonal concepts:
 *   - `optional` marks a skill as not-guaranteed-to-exist (third-party, operator-installed via
 *     `install-skill`) — it never restricts which hub types receive the skill.
 *   - `hubType` restricts which deploy tiers receive the skill by default (e.g. a dev:graph-only
 *     skill must not ship in a plain `dev` free-tier deploy) — it does not affect presence
 *     guarantees.
 *   - `requiresGraphify` layers an additional entitlement check on top of `hubType` — a skill
 *     can be gated to `["dev:graph", "dev:sub", "ops"]` and still only ship to `dev:sub`/`ops`
 *     when that specific deploy was built with `--with-graphify` (see `skillShipsToHubType`).
 *
 * Any other shape (e.g. an object with no `name`) normalises to an empty name —
 * callers should filter those out (see normalizeSkillList).
 *
 * @param {string|{name: string, optional?: boolean, hubType?: string|string[], requiresGraphify?: boolean}} entry
 * @returns {{ name: string, optional: boolean, hubType: string[]|undefined, requiresGraphify: boolean }}
 */
export function normalizeSkillEntry(entry) {
	if (typeof entry === 'string') {
		return { name: entry, optional: false, hubType: undefined, requiresGraphify: false };
	}
	if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
		return {
			name: entry.name,
			optional: entry.optional === true,
			hubType: normalizeHubType(entry.hubType),
			requiresGraphify: entry.requiresGraphify === true,
		};
	}
	return { name: '', optional: false, hubType: undefined, requiresGraphify: false };
}

/**
 * Normalise a raw manifest `hubType` value (single string or array of strings) into an array of
 * strings, or `undefined` if absent/malformed. Non-string entries within an array are dropped;
 * an empty or all-malformed result normalises to `undefined` (equivalent to "no hubType set").
 *
 * @param {string|string[]|undefined} value
 * @returns {string[]|undefined}
 */
function normalizeHubType(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) {
		const strings = value.filter(v => typeof v === 'string');
		return strings.length > 0 ? strings : undefined;
	}
	return undefined;
}

/**
 * Determine whether a skill with the given normalised `hubType` declaration should ship to a
 * deploy of the given `hubType`. A skill with no `hubType` declared (`undefined`) is universal —
 * it ships to every hub tier. A skill with a `hubType` array ships only when the deploy's own
 * `hubType` is a member of that array (array-membership, not exact-match — the hub tiers form
 * an upward ladder).
 *
 * When a skill also declares `requiresGraphify: true`, an additional entitlement check applies:
 * the skill only ships to `dev:sub`/`ops` (or any hubType other than `dev:graph`) when the current
 * deploy was run with `--with-graphify`. `dev:graph` is exempt from this extra check — it already
 * ships Graphify-dependent content unconditionally and never sets `withGraphify` itself.
 *
 * @param {string[]|undefined} skillHubType         Normalised `hubType` from normalizeSkillEntry/List.
 * @param {string|null}        [hubType]             The current deploy's own hubType.
 * @param {object}              [options]
 * @param {boolean}            [options.requiresGraphify=false]  Whether the skill needs the deploy's
 *                                                                 Graphify entitlement to ship outside
 *                                                                 `dev:graph`.
 * @param {boolean}            [options.withGraphify=false]      Whether the current deploy was run
 *                                                                 with `--with-graphify`.
 * @returns {boolean}
 */
export function skillShipsToHubType(skillHubType, hubType = null, options = {}) {
	const { requiresGraphify = false, withGraphify = false } = options;
	const hubTypeMatches = !skillHubType || skillHubType.length === 0 || skillHubType.includes(hubType);
	if (!hubTypeMatches) return false;
	if (requiresGraphify && hubType !== 'dev:graph' && !withGraphify) return false;
	return true;
}

/**
 * Normalise an entire manifest `skills` array into `{ name, optional, hubType }` objects.
 * Filters out malformed entries (no resolvable name).
 *
 * @param {Array<string|{name: string, optional?: boolean, hubType?: string|string[]}>} skills
 * @returns {Array<{ name: string, optional: boolean, hubType: string[]|undefined }>}
 */
export function normalizeSkillList(skills) {
	if (!Array.isArray(skills)) return [];
	return skills.map(normalizeSkillEntry).filter(s => s.name);
}

/**
 * Discover all *-workspace directories directly under profilesRoot.
 * Returns an array of absolute directory paths, sorted alphabetically.
 *
 * @param {string}        profilesRoot  Absolute path to the profiles root directory.
 * @param {string[]|null} [profileIds]  Optional allowlist of agent IDs (e.g. ['architect', 'builder']).
 *                                      When non-null, only profiles whose derived ID appears in the
 *                                      list are returned. Pass null (default) to return all profiles.
 */
export function discoverProfileDirs(profilesRoot, profileIds = null) {
	if (!fs.existsSync(profilesRoot)) return [];
	try {
		return fs.readdirSync(profilesRoot, { withFileTypes: true })
			.filter(e => e.isDirectory() && e.name.endsWith('-workspace'))
			.filter(e => !profileIds || profileIds.includes(e.name.replace(/-workspace$/i, '').trim().toLowerCase()))
			.map(e => path.join(profilesRoot, e.name))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Derive the agent id from a profile directory path.
 * e.g. /some/path/neo-workspace → neo
 */
export function profileDirToId(profileDir) {
	return path.basename(profileDir).replace(/-workspace$/i, '').trim().toLowerCase();
}

/**
 * Read and return the identity fields from IDENTITY.md.
 * Throws if IDENTITY.md is missing (required file).
 */
export function readProfileIdentity(profileDir) {
	const filePath = path.join(profileDir, 'IDENTITY.md');
	const content = readOptionalFile(filePath);
	if (!content) {
		throw new Error(`Required profile file not found: ${filePath}`);
	}
	const id = profileDirToId(profileDir);
	return {
		id,
		name: parseIdentityField(content, 'Name') ?? id,
		emoji: parseIdentityField(content, 'Emoji'),
		role: parseIdentityField(content, 'Role') ?? '',
		tagline: parseIdentityField(content, 'Tagline'),
		description: parseIdentityField(content, 'Description'),
	};
}
