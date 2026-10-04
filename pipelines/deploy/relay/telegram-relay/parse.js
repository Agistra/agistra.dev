import { stripRouterAddress } from '../core/names.js';

/** @typedef {import('../core/adapter-contract.js').ParsedInboundFields} ParsedInboundFields */

const WORKFLOW_PATTERNS = [
	['ci_failed', /\b(ci failed|test failed|build failed)\b/i],
	['qa_requested', /\b(ready for qa|needs qa|acceptance test|retest|qa requested)\b/i],
	['review_requested', /\b(ready for review|pr open|please review|review requested)\b/i],
	['decision_required', /\b(needs approval|\bscope\b|\bprice\b|\btimeline\b|client promise)\b/i],
	['blocked', /\b(blocked|waiting on|cannot proceed)\b/i],
	['info_only', /\b(fyi\b|status update\b|^status:)/i],
];

const ISSUE_RE = /(?:^|\s)#(\d+)\b|\bissue\s+#?(\d+)\b/i;
const PR_URL_RE = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/i;
const PR_HASH_RE = /\bPR\s*#(\d+)\b/i;
const BRANCH_RE = /\b(?:branch[:\s]+|on\s+)([\w./-]+)\b|\b((?:feat|fix|chore|refactor)\/[\w-]+)\b/i;

/**
 * Classify workflow state from message text (internal-relay vocabulary).
 *
 * @param {string} text
 * @returns {string}
 */
export function classifyWorkflowState(text) {
	const trimmed = text.trim();
	if (!trimmed) return 'unclear';

	for (const [state, pattern] of WORKFLOW_PATTERNS) {
		if (pattern.test(trimmed)) return state;
	}

	return 'unclear';
}

/**
 * Parse a Telegram update into structured inbound fields for Router.
 *
 * @param {object} update
 * @param {string} [routerDisplayName] When set, salutation is stripped before field extraction.
 * @returns {ParsedInboundFields | null}
 */
export function parseTelegramUpdate(update, routerDisplayName) {
	const msg = update?.message ?? update?.edited_message;
	if (!msg) return null;

	let raw_text = typeof msg.text === 'string'
		? msg.text
		: typeof msg.caption === 'string'
			? msg.caption
			: '';

	if (routerDisplayName) {
		raw_text = stripRouterAddress(raw_text, routerDisplayName);
	}

	const issueMatch = raw_text.match(ISSUE_RE);
	const issue = issueMatch
		? Number(issueMatch[1] ?? issueMatch[2])
		: undefined;

	let pr;
	const prUrl = raw_text.match(PR_URL_RE);
	if (prUrl) {
		pr = prUrl[0];
	} else {
		const prHash = raw_text.match(PR_HASH_RE);
		if (prHash) pr = `#${prHash[1]}`;
	}

	const branchMatch = raw_text.match(BRANCH_RE);
	const branch = branchMatch ? (branchMatch[1] ?? branchMatch[2]) : undefined;

	let workflow_state = classifyWorkflowState(raw_text);
	const requested_action = deriveRequestedAction(raw_text, { issue, pr, branch });

	return {
		issue,
		pr,
		branch,
		workflow_state,
		requested_action,
		raw_text,
		sender_id: msg.from?.id,
		message_id: msg.message_id,
		chat_id: msg.chat?.id,
	};
}

/**
 * @param {string} raw_text
 * @param {object} extracted
 * @returns {string}
 */
function deriveRequestedAction(raw_text, extracted) {
	let remainder = raw_text.trim();
	for (const pattern of [ISSUE_RE, PR_URL_RE, PR_HASH_RE, BRANCH_RE]) {
		remainder = remainder.replace(pattern, ' ');
	}
	remainder = remainder.replace(/\s+/g, ' ').trim();
	if (remainder) return remainder;
	if (extracted.issue) return `Issue #${extracted.issue}`;
	if (extracted.pr) return `PR ${extracted.pr}`;
	return raw_text.trim();
}
