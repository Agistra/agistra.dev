/**
 * hook-error-report.js — error reporting for the hub's hook scripts.
 *
 * A hook must never block or slow the agent, so this module loads the sender
 * lazily and swallows every failure of its own. Both functions return nothing
 * and never throw.
 *
 *   reportHookFailure(code, error)  a hook caught an error and carried on
 *   watchHookCrashes()              report an uncaught crash, then let Node
 *                                   exit exactly as it does today
 */

const SENDER = '../pipelines/deploy/lib/error-sources.js';

export async function reportHookFailure(code, error) {
	try {
		const sender = await import(SENDER);
		sender.reportHookFailure(code, error);
	} catch {
		// reporting is optional
	}
}

export async function watchHookCrashes() {
	try {
		const sender = await import(SENDER);
		sender.installCrashReporter({ source: 'hook' });
	} catch {
		// reporting is optional
	}
}
