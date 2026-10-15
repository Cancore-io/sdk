import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connect, type IpcClient } from '@cancore/botd/ipc/client';
import { createServer, SocketError, type BotClient } from './server';
import { socketErrorMessage } from './socket';

export { AGENT_METHODS, createServer, inventory, toolName, type BotClient } from './server';
export { DEFAULT_SOCKET, resolveSocketPath } from './socket';

export interface BotMcpOptions {
  /** Path of the cancore-botd unix socket. */
  socketPath: string;
  version?: string;
}

/** Starts the stdio MCP server proxying AGENT_METHODS to the daemon socket. */
export async function startServer(options: BotMcpOptions): Promise<void> {
  let client: Promise<IpcClient> | undefined;
  // Lazy and retried: the daemon may start after the agent, and a dead socket must not kill the MCP session.
  const getClient = (): Promise<BotClient> => {
    client ??= connect(options.socketPath).catch((err) => {
      client = undefined;
      throw new SocketError(socketErrorMessage(options.socketPath, err));
    });
    return client as Promise<BotClient>;
  };
  await createServer(getClient, options.version ?? '0.0.0').connect(new StdioServerTransport());
}
