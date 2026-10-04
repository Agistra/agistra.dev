import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DAEMON_PORT = 17391;

/**
 * @typedef {object} RelayConfig
 * @property {string} hubRoot
 * @property {string} botToken
 * @property {string} relayGroupId
 * @property {number} daemonPort
 * @property {string} [primaryRuntime]
 * @property {boolean} autoDispatch
 * @property {number} dispatchTimeoutSec
 * @property {number} recoveryPollSec
 * @property {number} processingTimeoutSec
 * @property {number} inboxRetentionDays
 * @property {number} logRetentionDays
 * @property {boolean} remoteTeamEnabled
 * @property {string[]} allowedSenders
 * @property {string} routerDisplayName
 * @property {string} remoteAgentName
 * @property {string} routerTelegramHandle
 * @property {string} [githubTrackingIssue]
 */

/**
 * Load relay configuration from hub workspace.config.json.
 *
 * @param {object} options
 * @param {string} options.hubRoot
 * @param {typeof fs} [options.fsMod]
 * @returns {RelayConfig}
 */
export function loadRelayConfig({ hubRoot, fsMod = fs }) {
	const configPath = path.join(hubRoot, 'workspace.config.json');
	if (!fsMod.existsSync(configPath)) {
		throw new Error('workspace.config.json not found — run: npm run setup');
	}

	let raw;
	try {
		raw = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'));
	} catch {
		throw new Error('workspace.config.json is not valid JSON');
	}

	const telegram = raw?.telegram;
	if (!telegram || telegram.enabled === false) {
		throw new Error('telegram is disabled or missing in workspace.config.json');
	}
	if (!telegram.bot_token) {
		throw new Error('telegram.bot_token is required in workspace.config.json');
	}
	if (!telegram.relay_group_id) {
		throw new Error('telegram.relay_group_id is required in workspace.config.json');
	}

	const relay = raw?.relay ?? {};

	return {
		hubRoot: path.resolve(hubRoot),
		botToken: telegram.bot_token,
		relayGroupId: String(telegram.relay_group_id),
		daemonPort: Number(relay.daemonPort) || DEFAULT_DAEMON_PORT,
		primaryRuntime: relay.primaryRuntime,
		autoDispatch: relay.autoDispatch === true,
		dispatchTimeoutSec: Number(relay.dispatchTimeoutSec) || 300,
		recoveryPollSec: Number(relay.recoveryPollSec) || 60,
		processingTimeoutSec: Number(relay.processingTimeoutSec) || 600,
		inboxRetentionDays: (Number.isFinite(Number(relay.inboxRetentionDays)) && Number(relay.inboxRetentionDays) > 0)
			? Number(relay.inboxRetentionDays)
			: 7,
		logRetentionDays: (Number.isFinite(Number(relay.logRetentionDays)) && Number(relay.logRetentionDays) > 0)
			? Number(relay.logRetentionDays)
			: 30,
		remoteTeamEnabled: Boolean(raw?.remoteTeam?.enabled),
		allowedSenders: Array.isArray(relay.allowedSenders)
			? relay.allowedSenders.map(String)
			: [],
		routerDisplayName: (raw?.agents?.router?.displayName ?? '').trim() || 'Router',
		remoteAgentName: raw?.remoteTeam?.agentName ?? 'remote agent',
		routerTelegramHandle: raw?.remoteTeam?.telegram?.handle ?? '',
		githubTrackingIssue: relay.github?.trackingIssue ?? '',
	};
}

/**
 * Resolve hub root from CLI args or cwd.
 *
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveHubRoot(argv, cwd = process.cwd()) {
	const hubIdx = argv.indexOf('--hub');
	if (hubIdx !== -1 && argv[hubIdx + 1]) {
		return path.resolve(argv[hubIdx + 1]);
	}
	return path.resolve(cwd);
}

export { DEFAULT_DAEMON_PORT };
