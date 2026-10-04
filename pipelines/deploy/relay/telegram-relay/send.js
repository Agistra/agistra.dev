/**
 * Validate outbound POST body before sending to Telegram.
 *
 * @param {object} body
 * @param {string} chatId
 * @returns {{ text: string, reply_to_message_id?: number }}
 */
export function validateOutboundPayload(body, chatId) {
	if (!chatId) {
		throw new Error('relay group chat_id is not configured');
	}
	if (!body || typeof body !== 'object') {
		throw new Error('request body must be a JSON object');
	}
	const text = body.text;
	if (typeof text !== 'string' || text.trim().length === 0) {
		throw new Error('text is required and must be non-empty');
	}
	const result = { text: text.trim() };
	if (body.reply_to_message_id != null) {
		const id = Number(body.reply_to_message_id);
		if (!Number.isInteger(id) || id <= 0) {
			throw new Error('reply_to_message_id must be a positive integer');
		}
		result.reply_to_message_id = id;
	}
	return result;
}

/**
 * Send a text message via Telegram Bot API.
 *
 * @param {object} options
 * @param {string} options.botToken
 * @param {string} options.chatId
 * @param {string} options.text
 * @param {number} [options.replyToMessageId]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<object>}
 */
export async function sendTextMessage({
	botToken,
	chatId,
	text,
	replyToMessageId,
	fetchFn = fetch,
}) {
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const payload = {
		chat_id: chatId,
		text,
	};
	if (replyToMessageId != null) {
		payload.reply_to_message_id = replyToMessageId;
	}

	const response = await fetchFn(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	const result = await response.json();
	if (!result.ok) {
		const desc = result.description || response.statusText || 'sendMessage failed';
		throw new Error(desc);
	}
	return result;
}
