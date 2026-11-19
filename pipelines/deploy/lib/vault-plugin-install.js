/**
 * vault-plugin-install.js — the code of the vault's three community plugins,
 * downloaded at setup instead of shipped in a release.
 *
 * Obsidian upgrades plugins in place, so tracked plugin code made a hub's git
 * tree differ from the release as soon as a plugin updated. Release trees now
 * track none of it (hub.gitignore ignores everything under `vault/.obsidian/`).
 * Setup installs each plugin from the published GitHub release it is pinned to:
 *
 *   - a plugin that is already present (main.js and manifest.json exist) is never
 *     touched, so an upgraded copy stays;
 *   - all three files are downloaded and checked against the SHA-256 pinned below
 *     before the first byte is written, so a mismatch writes nothing;
 *   - a source that cannot be reached never fails setup; the result is reported
 *     and doctor names the missing plugin.
 *
 * To bump a pin: download the three assets of the new release tag, hash them
 * (`sha256sum`), replace `version` and the three hashes here, run `npm test`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];

/** How long one asset download may take before the source counts as unreachable. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The plugins setup installs. `repo` is the GitHub repository whose release
 * `version` (the tag) carries the three assets; `sha256` maps asset name to the
 * hash of the published file.
 */
export const VAULT_PLUGIN_PINS = Object.freeze([
	{
		id: 'obsidian-local-rest-api',
		repo: 'coddingtonbear/obsidian-local-rest-api',
		version: '5.1.0',
		sha256: {
			'main.js':
				'c3bf3ef644c5ade946c4ab64821a5969a92124e00afb4dc9bac4034d482ce131',
			'manifest.json':
				'6c0d8390e6aa3f3515c834e2b4174545cf0cd20c5dbb116216e5d36b72af8437',
			'styles.css':
				'a8b5c52e4974bd356225a17d64e6ea25502206ad860641da260fdc14430426f8',
		},
	},
	{
		id: 'colorful-folders',
		repo: 'rohitnahar-offical/colorful-folders-obsidian',
		version: '5.0.5',
		sha256: {
			'main.js':
				'2f2f21297f7336d0006d2b7d18940d98093811350f45c5799023f9650187d20a',
			'manifest.json':
				'3f7f69be62820180b31c03b0722db963f7aecb02d0e21135ae1ff2ad2bcbdc7b',
			'styles.css':
				'6244c59a146657fe46692c6a4521df47f2b743bf42be2d4f20cf08f8af86908c',
		},
	},
	{
		id: 'graph-styler',
		repo: 'moonweave/obsidian-graph-styler',
		version: '0.1.7',
		sha256: {
			'main.js':
				'53390d1e2b2225ba6f0c9dba6d09ab42a662fd19dab8260dc8c3411dd41bb6c7',
			'manifest.json':
				'b91edfd1a68350d14db801d165aa50c1ac82b0925ad316674c4dcce9733ca8d4',
			'styles.css':
				'6eca4e49ca03f0a254d1bc6abbe230aef46b750dd8641904c0a299c0846eb917',
		},
	},
]);

/** The command doctor names for a missing plugin. */
export const VAULT_PLUGIN_REPAIR_COMMAND = 'npm run setup';

export function vaultPluginDir(hubRoot, id) {
	return path.join(hubRoot, 'vault', '.obsidian', 'plugins', id);
}

export function assetUrl(pin, file) {
	return `https://github.com/${pin.repo}/releases/download/${pin.version}/${file}`;
}

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}

/** A plugin counts as installed when its code and manifest are both on disk. */
function isInstalled(hubRoot, id, fsMod) {
	const dir = vaultPluginDir(hubRoot, id);
	return (
		fsMod.existsSync(path.join(dir, 'main.js')) &&
		fsMod.existsSync(path.join(dir, 'manifest.json'))
	);
}

/**
 * Pins whose plugin code is missing from the vault. Read-only; used by doctor.
 * Returns an empty list when the hub has no vault.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {object} [opts.fsMod]
 * @param {readonly object[]} [opts.pins]
 * @returns {Array<{ id: string, version: string }>}
 */
export function missingVaultPlugins({
	hubRoot,
	fsMod = fs,
	pins = VAULT_PLUGIN_PINS,
}) {
	if (!fsMod.existsSync(path.join(hubRoot, 'vault'))) return [];
	return pins
		.filter((pin) => !isInstalled(hubRoot, pin.id, fsMod))
		.map((pin) => ({ id: pin.id, version: pin.version }));
}

class SourceUnreachable extends Error {}

async function download(url, fetchFn) {
	let res;
	try {
		res = await fetchFn(url, {
			headers: { 'User-Agent': 'agistra-setup' },
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		throw new SourceUnreachable(
			`${url} could not be reached (${err?.cause?.code ?? err?.message ?? err})`,
		);
	}
	if (!res.ok) {
		throw new SourceUnreachable(`${url} answered HTTP ${res.status}`);
	}
	try {
		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		throw new SourceUnreachable(
			`${url} download was interrupted (${err?.message ?? err})`,
		);
	}
}

/**
 * Install one pinned plugin. Writes nothing unless all three files download and
 * match their pinned hash.
 */
async function installOne({ hubRoot, pin, fsMod, fetchFn }) {
	const base = { id: pin.id, version: pin.version };
	if (isInstalled(hubRoot, pin.id, fsMod)) {
		return { ...base, status: 'present' };
	}
	const files = new Map();
	try {
		for (const file of PLUGIN_FILES) {
			const body = await download(assetUrl(pin, file), fetchFn);
			const actual = sha256(body);
			if (actual !== pin.sha256[file]) {
				return {
					...base,
					status: 'checksum-mismatch',
					detail: `${file} from ${assetUrl(pin, file)} has SHA-256 ${actual}, expected ${pin.sha256[file]}; nothing was written`,
				};
			}
			files.set(file, body);
		}
	} catch (err) {
		if (err instanceof SourceUnreachable) {
			return { ...base, status: 'unreachable', detail: err.message };
		}
		throw err;
	}
	const dir = vaultPluginDir(hubRoot, pin.id);
	try {
		fsMod.mkdirSync(dir, { recursive: true });
		for (const [file, body] of files) {
			const target = path.join(dir, file);
			const tmp = `${target}.download`;
			fsMod.writeFileSync(tmp, body);
			fsMod.renameSync(tmp, target);
		}
	} catch (err) {
		return {
			...base,
			status: 'write-failed',
			detail: `${dir} could not be written (${err?.message ?? err})`,
		};
	}
	return { ...base, status: 'installed' };
}

/**
 * Install every pinned plugin that is missing from the hub's vault. Never throws
 * for a download problem and never touches a plugin that is already present.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot
 * @param {object} [opts.fsMod]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {readonly object[]} [opts.pins]
 * @returns {Promise<Array<{ id: string, version: string, status: 'installed'|'present'|'checksum-mismatch'|'unreachable'|'write-failed'|'no-vault', detail?: string }>>}
 */
export async function ensureVaultPlugins({
	hubRoot,
	fsMod = fs,
	fetchFn = globalThis.fetch,
	pins = VAULT_PLUGIN_PINS,
}) {
	if (!fsMod.existsSync(path.join(hubRoot, 'vault'))) {
		return pins.map((pin) => ({
			id: pin.id,
			version: pin.version,
			status: 'no-vault',
		}));
	}
	const results = [];
	for (const pin of pins) {
		results.push(await installOne({ hubRoot, pin, fsMod, fetchFn }));
	}
	return results;
}
