import { RISK_CLASS, type Method } from '@cancore/botd/protocol';

/**
 * The daemon methods an agent may reach. Owner-class methods (unlock, lock,
 * resume, limits.set) are absent by construction, and there is no withdraw,
 * send or key export on the socket at all.
 */
export const AGENT_METHODS: readonly Method[] = (Object.keys(RISK_CLASS) as Method[]).filter(
  (method) => RISK_CLASS[method] !== 'owner',
);

export interface BotMcpOptions {
  /** Path of the cancore-botd unix socket. */
  socketPath: string;
}

/** Starts the stdio MCP server proxying AGENT_METHODS to the daemon socket. */
export function startServer(options: BotMcpOptions): Promise<void> {
  void options;
  throw new Error('not implemented');
}
