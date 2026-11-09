/**
 * CLI plugin discovery: lets a hub tier add behaviour to the `task create` and
 * `scan` commands without the shared command files naming that behaviour.
 *
 * Every "*.cli-plugin.js" file in this directory is a plugin. Deploy copies
 * such a file only into the tiers that are meant to have it, so a hub without
 * the file has no hook, no extra option and no help line for it. Discovery by
 * filename suffix mirrors "*.setup-plugin.js" (setup.js) and
 * "*.doctor-plugin.js" (doctor.js).
 *
 * This is the whole extension surface. A plugin module may export:
 *
 *   afterTaskCreate({ hubRoot, output }) -> Promise<void>
 *     Runs after a successful `task create` in a hub (`--projects-root` means
 *     no hub, so it is skipped). Must not throw into task creation; the caller
 *     catches and reports anything it does throw on stderr.
 *
 *   scan = { flags, usage, description, run }
 *     flags        string[]  extra option names that take no value (booleans).
 *     usage        string    option synopsis added to the `scan` usage line.
 *     description  string    one-line note shown next to that synopsis.
 *     run(ctx)     Promise<{ok: boolean}>  replaces the plain scan call.
 *                  ctx = { args, scanOptions, scanFn } where args is the
 *                  parsed command line, scanOptions is what scan() takes and
 *                  scanFn runs the scan itself.
 *
 * Only one plugin's `scan` handler is used (the first by filename).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CLI_PLUGIN_SUFFIX = '.cli-plugin.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.libDir]  Directory to search; defaults to this file's own directory.
 * @returns {Promise<object[]>}   The plugin modules, in filename order. Empty when none are present.
 */
export async function loadCliPlugins({ libDir = __dirname } = {}) {
	let files;
	try {
		files = fs
			.readdirSync(libDir)
			.filter((f) => f.endsWith(CLI_PLUGIN_SUFFIX))
			.sort();
	} catch {
		return [];
	}
	const plugins = [];
	for (const file of files) {
		plugins.push(await import(pathToFileURL(path.join(libDir, file)).href));
	}
	return plugins;
}

/** The first plugin that supplies a `scan` handler, or undefined. */
export function scanPlugin(plugins) {
	return plugins.find((p) => p.scan && typeof p.scan.run === 'function')?.scan;
}

/** Names of the extra no-value options the plugins add to `scan`. */
export function extraBooleanFlags(plugins) {
	return scanPlugin(plugins)?.flags ?? [];
}

/** Usage and description for the extra `scan` options, or null when there are none. */
export function scanHelp(plugins) {
	const scan = scanPlugin(plugins);
	if (!scan?.usage) return null;
	return { usage: scan.usage, description: scan.description ?? '' };
}
