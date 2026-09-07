/**
 * `@cancore/mcp` — an MCP server that lets an agent ask a Cancore wallet owner
 * for a trade, and nothing more.
 *
 * Run it as a binary (`npx @cancore/mcp`), or import these pieces to embed the
 * same surface in your own server.
 */
export { AgentQueueClient, ForbiddenError, UnauthorizedError } from './client';
export type {
  AutotradeProposal,
  ClientOptions,
  Intent,
  IntentStatus,
  OrderProposal,
  TransferProposal,
} from './client';
export { AGENT_SCOPES, awaitGrant, pollGrant, startAuthorization } from './device';
export type { AwaitOptions, DeviceStart, PollOutcome, PollStatus } from './device';
export { defaultGrantPath, forgetGrant, loadGrant, saveGrant } from './grant';
export type { Grant } from './grant';
export { CancoreSession } from './session';
export type { SessionConfig, SessionDeps, ToolResult } from './session';
export { createServer, registerAgentTools } from './server';
