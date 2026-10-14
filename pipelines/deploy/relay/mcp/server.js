#!/usr/bin/env node
/**
 * Relay MCP server — exposes relay_* tools that proxy to the local daemon HTTP API.
 *
 * Usage:
 *   node pipelines/deploy/relay/mcp/server.js --hub <hub-root>
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveHubRoot } from '../telegram-relay/config.js';
import { createRelayClient } from './client.js';
import { RELAY_TOOLS, callRelayTool } from './tools.js';

const hubRoot = resolveHubRoot(process.argv.slice(2));
const client = createRelayClient({ hubRoot });

const server = new Server(
	{ name: 'relay', version: '0.1.0' },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: RELAY_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	try {
		const result = await callRelayTool(
			request.params.name,
			request.params.arguments ?? {},
			client,
		);
		return {
			content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: 'text', text: message }],
			isError: true,
		};
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
