#!/usr/bin/env node
/**
 * Check relay daemon health.
 *
 * Usage:
 *   node pipelines/deploy/relay/telegram-relay/status.js --hub <hub-root>
 */
import { loadRelayConfig, resolveHubRoot } from './config.js';

const hubRoot = resolveHubRoot(process.argv.slice(2));

let config;
try {
	config = loadRelayConfig({ hubRoot });
} catch (err) {
	process.stderr.write(`relay status: ${err.message}\n`);
	process.exit(1);
}

const url = `http://127.0.0.1:${config.daemonPort}/health`;

try {
	const response = await fetch(url);
	const data = await response.json();
	if (data.ok) {
		process.stdout.write(
			`relay OK — channel=${data.channel} polling=${data.polling} inbox_pending=${data.inbox_pending}\n`,
		);
		process.exit(0);
	}
	process.stderr.write(`relay NOT OK: ${JSON.stringify(data)}\n`);
	process.exit(1);
} catch {
	process.stderr.write(
		`relay daemon not reachable at ${url} — start with: npm run relay -- --hub ${hubRoot}\n`,
	);
	process.exit(1);
}
