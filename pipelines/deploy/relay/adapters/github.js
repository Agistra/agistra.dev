/**
 * GitHub relay adapter — posts inbound jobs to a tracking issue when MCP is unavailable.
 *
 * @typedef {import('../core/adapter-contract.js').InboundJob} InboundJob
 */

const TRACKING_ISSUE_RE = /^([^/]+)\/([^#]+)#(\d+)$/;

/**
 * @param {string} ref e.g. "owner/repo#123"
 * @returns {{ owner: string, repo: string, issueNumber: number }}
 */
export function parseTrackingIssue(ref) {
	const trimmed = (ref ?? '').trim();
	const match = trimmed.match(TRACKING_ISSUE_RE);
	if (!match) {
		throw new Error('tracking issue must be owner/repo#N (e.g. Agistra/setchin-agent-profiles#60)');
	}
	return {
		owner: match[1],
		repo: match[2],
		issueNumber: Number(match[3]),
	};
}

/**
 * @param {InboundJob} job
 * @returns {string}
 */
export function buildInboundComment(job) {
	const lines = [
		'@router INBOUND from remote team',
		`- job_id: \`${job.id}\``,
		`- workflow_state: \`${job.workflow_state ?? 'unclear'}\``,
	];
	if (job.issue != null) lines.push(`- issue: #${job.issue}`);
	if (job.pr) lines.push(`- pr: ${job.pr}`);
	if (job.branch) lines.push(`- branch: ${job.branch}`);
	if (job.requested_action) lines.push(`- action: ${job.requested_action}`);
	lines.push(`- raw: ${(job.raw_text ?? '').replace(/\n/g, ' ').slice(0, 500)}`);
	return lines.join('\n');
}

/**
 * @param {object} config RelayConfig subset
 * @returns {boolean}
 */
export function shouldNotifyGithub(config) {
	return config.primaryRuntime === 'github' && Boolean(config.githubTrackingIssue);
}

/**
 * Post inbound job notification to the configured GitHub tracking issue.
 *
 * @param {object} options
 * @param {InboundJob} options.job
 * @param {object} options.config
 * @param {string} [options.token] GITHUB_TOKEN — falls back to process.env.GITHUB_TOKEN
 * @param {typeof fetch} [options.fetchFn]
 */
export async function postInboundComment({ job, config, token, fetchFn = fetch }) {
	const authToken = token ?? process.env.GITHUB_TOKEN;
	if (!authToken) {
		throw new Error('GITHUB_TOKEN is required to post GitHub relay comments');
	}
	if (!config.githubTrackingIssue) {
		throw new Error('relay.github.trackingIssue is not configured');
	}

	const { owner, repo, issueNumber } = parseTrackingIssue(config.githubTrackingIssue);
	const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
	const body = buildInboundComment(job);

	const response = await fetchFn(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${authToken}`,
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		body: JSON.stringify({ body }),
	});

	let data;
	try {
		data = await response.json();
	} catch {
		data = {};
	}

	if (!response.ok) {
		throw new Error(data.message || `GitHub API error (${response.status})`);
	}

	return data;
}

/**
 * Extract outbound relay text from a GitHub issue body (used by github-action.yml).
 *
 * @param {string} body
 * @returns {string | null}
 */
export function parseOutboundFromIssueBody(body) {
	const marker = '## relay:outbound';
	const idx = (body ?? '').indexOf(marker);
	if (idx === -1) return null;
	return body.slice(idx + marker.length).trim();
}
