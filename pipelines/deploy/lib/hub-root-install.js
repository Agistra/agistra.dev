import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Setup-time install of the hub root's own npm dependencies.
 *
 * buildPackageJson() (lib/extras.js) writes outputRoot/package.json
 * unconditionally on every hub tier (it declares @modelcontextprotocol/sdk,
 * the runtime dependency pipelines/deploy/relay/mcp/server.js and a
 * vault-backed tier's stdio MCP proxy script (packages/vault/vault-guard.cjs)
 * both need), and a package-lock.json ships alongside it in the packaged
 * archive — but nothing in the deploy pipeline ever ran `npm ci`/`npm
 * install` at the hub root to materialise node_modules/ from that lockfile.
 * Confirmed on a real hub: vault-guard.cjs crashed with MODULE_NOT_FOUND
 * ("Cannot find module '@modelcontextprotocol/sdk/server/stdio.js'") until
 * node_modules/ was installed by hand — its MCP server connected immediately
 * afterward.
 *
 * This module is generic: it reads whichever dependencies the hub's own
 * package.json actually declares (never hardcodes a package name), so it
 * keeps working unchanged if that dependency set ever grows or shrinks.
 *
 * Idempotency mirrors the presence-check-before-acting precedent
 * lib/nightly-dreaming.js's isNightlyDreamingTaskRegistered() established for
 * setup.js's other early steps: real on-disk presence of every declared
 * dependency is checked before running an install, so a re-run of
 * `npm run setup` on a hub whose node_modules/ is already current never
 * blindly reinstalls.
 */

/**
 * Real on-disk presence check: does node_modules/<dep> exist for every
 * dependency declared in the hub root's package.json `dependencies` block?
 * A scoped package name (e.g. "@modelcontextprotocol/sdk") is checked at its
 * real nested directory (node_modules/@modelcontextprotocol/sdk), not a
 * single flattened path segment.
 *
 * Never throws: an absent or unparseable package.json is treated as
 * "nothing declared, nothing missing" (current: true) — there is nothing
 * this step could usefully install in that case, and it must not block the
 * rest of setup/doctor.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot  Absolute path to the hub root.
 * @param {object} [opts.fsMod]  Injectable fs module (real fs or an in-memory mock).
 * @returns {{ declared: string[], missing: string[], current: boolean }}
 */
export function checkHubRootDepsCurrent({ hubRoot, fsMod = fs }) {
	const pkgPath = path.join(hubRoot, 'package.json');
	if (!fsMod.existsSync(pkgPath)) {
		return { declared: [], missing: [], current: true };
	}
	let pkg;
	try {
		pkg = JSON.parse(fsMod.readFileSync(pkgPath, 'utf-8'));
	} catch {
		return { declared: [], missing: [], current: true };
	}
	const declared = Object.keys(pkg.dependencies ?? {}).sort();
	const missing = declared.filter(
		(dep) => !fsMod.existsSync(path.join(hubRoot, 'node_modules', ...dep.split('/'))),
	);
	return { declared, missing, current: missing.length === 0 };
}

/**
 * Real npm install at the hub root — `npm ci` when a package-lock.json is
 * present (reproducible install matching the shipped lockfile), falling
 * back to `npm install` when it is absent (e.g. a hand-rolled hub without a
 * committed lockfile).
 *
 * @param {object} opts
 * @param {string} opts.hubRoot  Absolute path to the hub root (also the npm cwd).
 * @param {object} [opts.fsMod]  Injectable fs module.
 * @param {function} [opts.execFn]  Injectable execFileSync(cmd, args, options) —
 *   defaults to the real child_process.execFileSync so this actually spawns
 *   npm in production. Overridable so unit tests can verify wiring without
 *   spawning a real npm process.
 * @returns {{ ran: true, command: 'ci'|'install' } | { ran: false, command: 'ci'|'install', error: string }}
 */
export function installHubRootDeps({ hubRoot, fsMod = fs, execFn = execFileSync }) {
	const useCi = fsMod.existsSync(path.join(hubRoot, 'package-lock.json'));
	const command = useCi ? 'ci' : 'install';
	try {
		// shell: true on Windows — same precedent this pipeline's other
		// setup-time `npm ci` install helpers already established: npm resolves
		// to npm.cmd on Windows, and execFileSync without a shell cannot
		// resolve/execute a .cmd shim directly.
		execFn('npm', [command], { cwd: hubRoot, stdio: 'inherit', shell: process.platform === 'win32' });
		return { ran: true, command };
	} catch (err) {
		return { ran: false, command, error: err.message };
	}
}

/**
 * Idempotent, presence-checked entry point — the step setup.js runs early on
 * every `npm run setup` invocation. Skips the real install entirely when
 * checkHubRootDepsCurrent() already reports every declared dependency
 * present on disk, so a re-run of `npm run setup` against an
 * already-installed hub never blindly reinstalls.
 *
 * Never throws on install failure — a failed npm install here must not abort
 * the rest of the setup wizard (the same non-fatal posture setup.js already
 * uses for e.g. the statusline install and nightly-dreaming Scheduled Task
 * registration steps). Callers that need to know whether the install
 * actually succeeded should check the returned `ran`/`error` fields.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot  Absolute path to the hub root.
 * @param {object} [opts.fsMod]  Injectable fs module.
 * @param {function} [opts.execFn]  Injectable execFileSync, forwarded to installFn.
 * @param {function(string): void} [opts.log]  Injectable logger.
 * @param {function} [opts.installFn]  Injectable installHubRootDeps() — defaults to
 *   the real implementation. Overridable so unit tests can verify this step's
 *   own wiring (presence-check, skip-vs-run decision) without spawning a real
 *   npm install.
 * @returns {{ skipped: true, declared: string[] } |
 *   { skipped: false, ran: boolean, command: 'ci'|'install', error?: string }}
 */
export function ensureHubRootDepsInstalled({
	hubRoot,
	fsMod = fs,
	execFn = execFileSync,
	log = (s) => process.stdout.write(s),
	installFn = installHubRootDeps,
}) {
	const { declared, missing, current } = checkHubRootDepsCurrent({ hubRoot, fsMod });
	if (declared.length === 0) {
		// No package.json, or no dependencies declared — nothing to install.
		return { skipped: true, declared };
	}
	if (current) {
		log(`  Hub-root dependencies already installed (${declared.length} present in node_modules/).\n`);
		return { skipped: true, declared };
	}
	log(`  Installing hub-root dependencies (missing: ${missing.join(', ')})...\n`);
	const result = installFn({ hubRoot, fsMod, execFn });
	if (result.ran) {
		log(`  Hub-root dependencies installed via npm ${result.command}.\n`);
	} else {
		log(`  WARNING: hub-root dependency install failed: ${result.error}\n`);
		log('  Re-run npm run setup to retry, or run npm install manually at the hub root.\n');
	}
	return { skipped: false, ...result };
}
