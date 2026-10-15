export const DEFAULT_SOCKET = '/run/cancore-bot/bot.sock';

/** `--socket <path>` / `--socket=<path>`, then CANCORE_BOT_SOCKET, then the default. */
export function resolveSocketPath(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const i = argv.findIndex((a) => a === '--socket' || a.startsWith('--socket='));
  const flag = i < 0 ? undefined : argv[i]!.includes('=') ? argv[i]!.slice('--socket='.length) : argv[i + 1];
  return flag || env.CANCORE_BOT_SOCKET || DEFAULT_SOCKET;
}

export function socketErrorMessage(socketPath: string, err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED')
    return `No cancore-botd socket at ${socketPath}: is the daemon running? Set --socket or CANCORE_BOT_SOCKET if it lives elsewhere.`;
  if (code === 'EACCES' || code === 'EPERM')
    return `Permission denied on ${socketPath}: add this user to the cancore-bot-clients group (then log in again).`;
  return `Cannot reach cancore-botd at ${socketPath}: ${code ?? 'unknown error'}.`;
}
