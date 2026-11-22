/**
 * tier-descriptor.js — the one place that says what each hub type is and has.
 *
 * Every hub-type list in the deploy pipeline (BEDROCK_HUB_TYPES,
 * VAULT_BACKED_HUB_TYPES, TIP_HUB_TYPES, ...) is derived from the table below,
 * so a tier cannot be listed in one place and forgotten in another. Each entry
 * states every capability as an explicit true or false: a missing or
 * non-boolean decision fails the guard test (test/tier-descriptor.test.js).
 *
 * Six names exist. Four are canonical tiers: the hubType stamped into a built
 * hub. Two are long-name aliases that resolve to a canonical tier built with
 * Graphify (`dev:sub:graph` = `dev:sub` + Graphify, `ops:graph` = `ops` +
 * Graphify). The `canonical` capability is true only for the four canonical
 * tiers: lists that are tested against a stamped hubType take canonical names
 * only; lists that also accept the long names say so in their derivation.
 *
 * Dependency-free on purpose: every lib file that carries a tier list imports
 * this module, and it ships to every hub tier.
 */

/**
 * Capability names, in the order entries state them. Adding a name here
 * without adding it to every entry below fails the guard test.
 */
export const TIER_CAPABILITIES = Object.freeze([
	'canonical',
	'graphify',
	'graphifyAddon',
	'vaultBacked',
	'vaultShaped',
	'vaultSource',
	'obsidian',
	'qmd',
	'bedrock',
	'licence',
	'scan',
	'tips',
	'compiledBootstrap',
	'graphLensHook',
	'tierPluginQuestions',
	'packageCounterpart',
	'paid',
	'errorReportsExcludable',
	'customerReadme',
]);

/**
 * One entry per accepted hub-type name, in `--hub-type` order.
 *
 * `base` is the canonical tier the name resolves to; `order` is the tier's
 * position in the migration ordering (canonical tiers only, else null).
 * Aliases state the same decisions as their base tier.
 */
export const TIER_DESCRIPTORS = Object.freeze({
	dev: {
		base: 'dev',
		order: 0,
		canonical: true,
		graphify: false,
		graphifyAddon: false,
		vaultBacked: false,
		vaultShaped: false,
		vaultSource: false,
		obsidian: false,
		qmd: false,
		bedrock: false,
		licence: false,
		scan: false,
		tips: true,
		compiledBootstrap: true,
		graphLensHook: false,
		tierPluginQuestions: false,
		packageCounterpart: true,
		paid: false,
		errorReportsExcludable: true,
		customerReadme: false,
	},
	'dev:graph': {
		base: 'dev:graph',
		order: 1,
		canonical: true,
		graphify: true,
		graphifyAddon: false,
		vaultBacked: false,
		vaultShaped: false,
		vaultSource: false,
		obsidian: false,
		qmd: false,
		bedrock: true,
		licence: true,
		scan: false,
		tips: true,
		compiledBootstrap: false,
		graphLensHook: true,
		tierPluginQuestions: true,
		packageCounterpart: true,
		paid: false,
		errorReportsExcludable: true,
		customerReadme: true,
	},
	'dev:sub': {
		base: 'dev:sub',
		order: 2,
		canonical: true,
		graphify: false,
		graphifyAddon: true,
		vaultBacked: true,
		vaultShaped: true,
		vaultSource: true,
		obsidian: true,
		qmd: true,
		bedrock: true,
		licence: true,
		scan: true,
		tips: true,
		compiledBootstrap: false,
		graphLensHook: true,
		tierPluginQuestions: true,
		packageCounterpart: true,
		paid: true,
		errorReportsExcludable: false,
		customerReadme: true,
	},
	'dev:sub:graph': {
		base: 'dev:sub',
		order: null,
		canonical: false,
		graphify: true,
		graphifyAddon: true,
		vaultBacked: true,
		vaultShaped: true,
		vaultSource: true,
		obsidian: true,
		qmd: true,
		bedrock: true,
		licence: true,
		scan: true,
		tips: true,
		compiledBootstrap: false,
		graphLensHook: true,
		tierPluginQuestions: true,
		packageCounterpart: true,
		paid: true,
		errorReportsExcludable: false,
		customerReadme: true,
	},
	ops: {
		base: 'ops',
		order: 3,
		canonical: true,
		graphify: false,
		graphifyAddon: true,
		vaultBacked: true,
		vaultShaped: true,
		vaultSource: true,
		obsidian: true,
		qmd: false,
		bedrock: true,
		licence: true,
		scan: true,
		tips: false,
		compiledBootstrap: false,
		graphLensHook: true,
		tierPluginQuestions: true,
		packageCounterpart: true,
		paid: true,
		errorReportsExcludable: false,
		customerReadme: true,
	},
	'ops:graph': {
		base: 'ops',
		order: null,
		canonical: false,
		graphify: true,
		graphifyAddon: true,
		vaultBacked: true,
		vaultShaped: true,
		vaultSource: true,
		obsidian: true,
		qmd: false,
		bedrock: true,
		licence: true,
		scan: true,
		tips: false,
		compiledBootstrap: false,
		graphLensHook: true,
		tierPluginQuestions: true,
		packageCounterpart: true,
		paid: true,
		errorReportsExcludable: false,
		customerReadme: true,
	},
});

/** Every accepted hub-type name, in `--hub-type` order. */
export const ALL_HUB_TYPE_NAMES = Object.freeze(Object.keys(TIER_DESCRIPTORS));

/**
 * Names with `capability` set, in table order.
 *
 * @param {string} capability
 * @param {{ canonicalOnly?: boolean }} [opts]  canonicalOnly: leave out the
 *   long-name aliases (the stamped-hubType lists).
 * @returns {string[]}
 */
export function hubTypesWith(capability, { canonicalOnly = true } = {}) {
	return ALL_HUB_TYPE_NAMES.filter((name) => {
		const entry = TIER_DESCRIPTORS[name];
		return entry[capability] === true && (!canonicalOnly || entry.canonical);
	});
}

/** The four canonical tiers, in migration order. */
export const CANONICAL_HUB_TYPES = Object.freeze(hubTypesWith('canonical'));

/**
 * Long-name aliases: name -> canonical tier built with Graphify.
 * `dev:sub:graph` -> `dev:sub`, `ops:graph` -> `ops`.
 */
export const GRAPHIFY_ALIASES = Object.freeze(
	Object.fromEntries(
		ALL_HUB_TYPE_NAMES.filter((name) => !TIER_DESCRIPTORS[name].canonical).map(
			(name) => [name, TIER_DESCRIPTORS[name].base],
		),
	),
);
