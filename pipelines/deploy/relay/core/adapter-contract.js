/**
 * Inbound job shape consumed by Router (telegram-relay skill).
 *
 * @typedef {object} ParsedInboundFields
 * @property {number} [issue]
 * @property {string} [pr]
 * @property {string} [branch]
 * @property {string} workflow_state
 * @property {string} [requested_action]
 * @property {string} raw_text
 * @property {number} [sender_id]
 * @property {number} [message_id]
 * @property {number} [chat_id]
 */

/**
 * @typedef {ParsedInboundFields & object} InboundJob
 * @property {string} id
 * @property {'pending'|'processing'|'done'|'failed'} status
 * @property {string} received_at ISO timestamp
 */

export {};
