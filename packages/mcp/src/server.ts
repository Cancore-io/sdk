import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CancoreSession, type ToolResult } from './session';

/**
 * The six tools, in one vocabulary with the Go server in
 * `Cancore-io/mcp-server`: same names, same arguments, same wording. An agent
 * that learned one has learned the other, and the two runtimes share a grant
 * file — which is only useful if they also share a surface.
 *
 * What is NOT here is the point: no signing tool, no key, no prepared
 * transaction. An agent may ask; only the owner's key executes. Caps and queue
 * limits live on the server and are deliberately not restated in these
 * descriptions — a description is attacker-reachable, the server is not.
 */
export const AGENT_LABEL_DESCRIPTION = 'how to identify yourself to the user (display only)';

function jsonResult(payload: ToolResult) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function registerAgentTools(server: McpServer, session: CancoreSession): McpServer {
  server.registerTool(
    'cancore_connect_wallet',
    {
      description:
        'Ask the Cancore wallet owner to authorize this server. Opens the consent page in their browser and waits; on approval the server keeps a scoped grant (queue a request, read the queue — never sign) and no token is returned to you. Call it when a cancore_* tool says there is no access, and call it again while it answers pending.',
      inputSchema: {
        appName: z.string().optional().describe('how to introduce yourself on the consent page (display only)'),
        waitSeconds: z
          .number()
          .optional()
          .describe('how long to wait for the owner in this call, 5–300 (default 45); the request stays live either way'),
        force: z.boolean().optional().describe('ask again even if this stand is already authorized'),
      },
    },
    async (args) => jsonResult(await session.connectWallet(args)),
  );

  server.registerTool(
    'cancore_propose_autotrade',
    {
      description:
        'Ask the Cancore wallet owner to approve an auto-trade — buying one token for another straight from the Cancore pool, with no counterparty to wait for. Queues a request and returns its id; it does NOT trade and never returns anything to sign. Name the pair by token symbol and do NOT invent a rate: the wallet prices it live and shows the owner what the trade would buy before they approve it. Poll cancore_intent_status for the outcome.',
      inputSchema: {
        sourceTokenName: z.string().describe('token symbol being spent, e.g. "CC"'),
        targetTokenName: z.string().describe('token symbol being bought, e.g. "CBTC"'),
        sourceAmount: z.string().describe('decimal amount to spend, e.g. "5"'),
        agentLabel: z.string().optional().describe(AGENT_LABEL_DESCRIPTION),
      },
    },
    async ({ agentLabel, ...proposal }) => jsonResult(await session.proposeAutotrade(proposal, agentLabel)),
  );

  server.registerTool(
    'cancore_propose_order',
    {
      description:
        'Ask the Cancore wallet owner to approve a cross-chain order (swap offer). Queues a request and returns its id — it does NOT place the order and never returns anything to sign. The user reviews it in their own create-order form and places it themselves; poll cancore_intent_status for the outcome.',
      inputSchema: {
        sourceNetwork: z.string().describe('network the maker pays from, e.g. "canton" or "sepolia"'),
        sourceTokenAddress: z.string().describe('instrument id (Canton) or contract address (EVM/Tron) being offered'),
        sourceAmount: z.string().describe('decimal amount offered, e.g. "5"'),
        targetNetwork: z.string().describe('network the maker wants to receive on'),
        targetTokenAddress: z.string().describe('instrument id or contract address wanted in return'),
        targetAmount: z.string().describe('decimal amount wanted, e.g. "12.5"'),
        sourceTokenName: z.string().optional().describe("display name for the offered token, when the wallet's token list may not carry it"),
        targetTokenName: z.string().optional().describe('display name for the wanted token'),
        agentLabel: z.string().optional().describe(AGENT_LABEL_DESCRIPTION),
      },
    },
    async ({ agentLabel, ...proposal }) => jsonResult(await session.proposeOrder(proposal, agentLabel)),
  );

  server.registerTool(
    'cancore_propose_transfer',
    {
      description:
        'Ask the Cancore wallet owner to approve a transfer. Queues a request and returns its id — it does NOT send funds and never returns anything to sign. The user reviews it in their wallet and signs with their own key; poll cancore_intent_status for the outcome.',
      inputSchema: {
        receiverPartyId: z.string().describe('Canton party id of the recipient ("hint::namespace")'),
        amount: z.string().describe('decimal amount, e.g. "1.5"'),
        tokenId: z.string().optional().describe("instrument to send; defaults to the wallet's CC"),
        description: z.string().optional().describe('memo shown to the user, and carried with the transfer'),
        agentLabel: z.string().optional().describe(AGENT_LABEL_DESCRIPTION),
      },
    },
    async ({ agentLabel, ...proposal }) => jsonResult(await session.proposeTransfer(proposal, agentLabel)),
  );

  server.registerTool(
    'cancore_intent_status',
    {
      description:
        'Outcome of a queued request: pending (waiting for the user), executed (signed and committed) or rejected.',
      inputSchema: { intentId: z.string() },
    },
    async ({ intentId }) => jsonResult(await session.intentStatus(intentId)),
  );

  server.registerTool(
    'cancore_list_intents',
    { description: "Requests still awaiting the wallet owner's decision.", inputSchema: {} },
    async () => jsonResult(await session.listIntents()),
  );

  return server;
}

export function createServer(session: CancoreSession, version: string): McpServer {
  const server = new McpServer({ name: 'cancore-mcp', version });
  return registerAgentTools(server, session);
}
