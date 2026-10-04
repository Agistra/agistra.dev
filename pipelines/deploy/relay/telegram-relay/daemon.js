#!/usr/bin/env node
/**
 * telegram-relay daemon — single Telegram poller + local HTTP API.
 *
 * Usage:
 *   node pipelines/deploy/relay/telegram-relay/daemon.js --hub <hub-root>
 */
import { loadRelayConfig, resolveHubRoot } from './config.js';
import { acquireDaemonLock } from './lock.js';
import { startPoller } from './poll.js';
import { createHttpServer } from './http.js';
import { InboundQueue } from '../core/queue.js';
import { createDaemonLogger } from '../core/logger.js';
import { postInboundComment, shouldNotifyGithub } from '../adapters/github.js';
import { shouldDispatchClaude, dispatchRouter, resetStaleJobs } from '../adapters/claude-code.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
const hubRoot = resolveHubRoot(argv);
const profilesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let config;
try {
	config = loadRelayConfig({ hubRoot });
} catch (err) {
	process.stderr.write(`relay daemon: ${err.message}\n`);
	process.exit(1);
}

let lock;
try {
	lock = acquireDaemonLock({ hubRoot });
} catch (err) {
	process.stderr.write(`relay daemon: ${err.message}\n`);
	process.exit(1);
}

const logger = createDaemonLogger(hubRoot);

const queue = new InboundQueue({ hubRoot });

let pollerRef = { polling: false };

const poller = startPoller({
	botToken: config.botToken,
	relayGroupId: config.relayGroupId,
	allowedSenders: config.allowedSenders,
	hubRoot,
	routerDisplayName: config.routerDisplayName,
	routerTelegramHandle: config.routerTelegramHandle,
	queue,
	afterEnqueue(job) {
		const truncated = (job.raw_text ?? '').slice(0, 80);
		logger.log(`enqueued job=${job.id} text="${truncated}"`);
		if (shouldNotifyGithub(config)) {
			postInboundComment({ job, config }).catch(err => {
				process.stderr.write(`relay github notify error: ${err.message}\n`);
			});
		}
		if (shouldDispatchClaude(config)) {
			dispatchRouter({ job, config, hubRoot, profilesRoot }).catch(err => {
				process.stderr.write(`relay claude dispatch error: ${err.message}\n`);
			});
		}
	},
	onError(err) {
		logger.log(`poll error: ${err.message}`);
		process.stderr.write(`relay poll error: ${err.message}\n`);
	},
});
pollerRef = poller;

if (shouldDispatchClaude(config)) {
	const recoveryMs = config.recoveryPollSec * 1000;
	setInterval(() => {
		resetStaleJobs({ queue, processingTimeoutSec: config.processingTimeoutSec, hubRoot });
		queue.pruneOldDone(config.inboxRetentionDays * 86400 * 1000);
		logger.pruneOldLogs(config.logRetentionDays * 86400 * 1000);
	}, recoveryMs).unref();
}

const server = createHttpServer({
	config,
	queue,
	isPolling: () => poller.polling,
});

server.listen(config.daemonPort, '127.0.0.1', () => {
	logger.log(`relay daemon started port=${config.daemonPort} hub=${hubRoot}`);
	process.stdout.write(
		`relay daemon listening on http://127.0.0.1:${config.daemonPort} (telegram)\n`,
	);
});

function shutdown(signal) {
	process.stdout.write(`relay daemon: ${signal}, shutting down\n`);
	poller.stop();
	server.close(() => {
		lock.release();
		process.exit(0);
	});
	setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
