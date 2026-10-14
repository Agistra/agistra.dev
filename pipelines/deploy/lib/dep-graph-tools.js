/** @typedef {ReturnType<import('./dep-graph-session.js').createDepGraphSession>} DepGraphSession */

// Tool schema mirrors relay/mcp/tools.js's shape (RELAY_TOOLS + callRelayTool)
// — same split of "declared MCP tool schema" from "dispatch to the session".

export const DEP_GRAPH_TOOLS = [
	{
		name: 'scan',
		description:
			'Scan a JS/TS project directory for dependency cycles and fan-in/fan-out coupling.',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description:
						'Absolute or relative path to the project directory to scan',
				},
			},
			required: ['path'],
		},
	},
	{
		name: 'baseline',
		description:
			'Save the most recent scan() result as the baseline for its scanned directory.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'diff',
		description:
			'Re-scan the last-scanned directory and compare the result against the saved baseline.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'check',
		description:
			'Rule-gate: fail if any new dependency cycle was introduced since the saved baseline.',
		inputSchema: { type: 'object', properties: {} },
	},
];

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {DepGraphSession} session
 */
export async function callDepGraphTool(name, args, session) {
	switch (name) {
		case 'scan':
			return session.scan(String(args.path));
		case 'baseline':
			return session.baseline();
		case 'diff':
			return session.diff();
		case 'check':
			return session.check();
		default:
			throw new Error(`unknown dep-graph tool: ${name}`);
	}
}
