/**
 * Escape a string for use in a RegExp.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string | undefined} handle
 * @returns {string}
 */
function normalizeHandle(handle) {
	return (handle ?? '').replace(/^@/, '').trim().toLowerCase();
}

const DEFAULT_ROUTER_NAME = 'Router';

/**
 * Resolve the salutation name(s) inbound messages must use for Router.
 * Uses agents.router.displayName when set; otherwise "Router".
 *
 * @param {string | undefined} routerDisplayName
 * @returns {string[]}
 */
export function getRouterInboundNames(routerDisplayName) {
	const configured = (routerDisplayName ?? '').trim();
	return [configured || DEFAULT_ROUTER_NAME];
}

/**
 * True when the message is addressed to Router (display name prefix or @bot mention).
 *
 * @param {string} text
 * @param {object} [message] Telegram message object (for entities)
 * @param {object} options
 * @param {string} options.routerDisplayName Configured name or fallback "Router"
 * @param {string} [options.routerTelegramHandle] e.g. "@atlas_vs_ai_bot"
 * @returns {boolean}
 */
export function isAddressedToRouter(text, message, { routerDisplayName, routerTelegramHandle }) {
	const trimmed = (text ?? '').trim();
	if (!trimmed) return false;

	for (const name of getRouterInboundNames(routerDisplayName)) {
		const namePattern = new RegExp(`^${escapeRegex(name)}\\s*[,:]\\s*`, 'i');
		if (namePattern.test(trimmed)) return true;
	}

	const handle = normalizeHandle(routerTelegramHandle);
	if (handle && trimmed.toLowerCase().includes(`@${handle}`)) return true;

	if (message?.entities && handle) {
		for (const entity of message.entities) {
			if (entity.type !== 'mention') continue;
			const mention = trimmed.slice(entity.offset, entity.offset + entity.length);
			if (normalizeHandle(mention) === handle) return true;
		}
	}

	return false;
}

/**
 * Remove Router salutation from the start of inbound text.
 *
 * @param {string} text
 * @param {string} routerDisplayName
 * @returns {string}
 */
export function stripRouterAddress(text, routerDisplayName) {
	let result = text.trim();
	for (const name of getRouterInboundNames(routerDisplayName)) {
		const pattern = new RegExp(`^${escapeRegex(name)}\\s*,?\\s*`, 'i');
		if (pattern.test(result)) {
			result = result.replace(pattern, '').trim();
			break;
		}
	}
	return result;
}

/**
 * Prefix outbound relay text with the remote agent's name when missing.
 *
 * @param {string} text
 * @param {string} remoteAgentName e.g. "Max"
 * @returns {string}
 */
export function formatOutboundToRemote(text, remoteAgentName) {
	const trimmed = text.trim();
	const remoteName = (remoteAgentName ?? '').trim();
	if (!remoteName) return trimmed;

	const prefixPattern = new RegExp(`^${escapeRegex(remoteName)}\\s*[,:]\\s*`, 'i');
	if (prefixPattern.test(trimmed)) return trimmed;

	return `${remoteName}, ${trimmed}`;
}

export { DEFAULT_ROUTER_NAME };
