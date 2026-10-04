/** @typedef {ReturnType<import('./client.js').createRelayClient>} RelayClient */

export const RELAY_TOOLS = [
	{
		name: 'relay_send',
		description: 'Send a validated outbound message via the relay daemon to Telegram.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Message text to send' },
				reply_to_message_id: {
					type: 'number',
					description: 'Optional Telegram message ID to reply to',
				},
			},
			required: ['text'],
		},
	},
	{
		name: 'relay_inbox_peek',
		description: 'Fetch the next parsed inbound relay job from the daemon inbox queue.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'relay_inbox_ack',
		description: 'Mark an inbound relay job as processed.',
		inputSchema: {
			type: 'object',
			properties: {
				job_id: { type: 'string', description: 'Job ID from relay_inbox_peek' },
			},
			required: ['job_id'],
		},
	},
	{
		name: 'relay_status',
		description: 'Check relay daemon health and inbox queue depth.',
		inputSchema: { type: 'object', properties: {} },
	},
];

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {RelayClient} client
 */
export async function callRelayTool(name, args, client) {
	switch (name) {
		case 'relay_send':
			return client.send({
				text: String(args.text),
				reply_to_message_id: args.reply_to_message_id,
			});
		case 'relay_inbox_peek':
			return client.inboxPeek();
		case 'relay_inbox_ack':
			return client.inboxAck(String(args.job_id));
		case 'relay_status':
			return client.status();
		default:
			throw new Error(`unknown relay tool: ${name}`);
	}
}
