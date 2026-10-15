#!/usr/bin/env node
/** cancore-bot: the owner CLI. Talks to the owner socket, so run it as the daemon user: `sudo -u cancore-bot cancore-bot …`. */
import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import { connect, RpcCallError } from './ipc/client';
import { createKeystore } from './keystore';
import { openAuditLog } from './audit';
import { flag, loadConfig, paths, type BotConfig } from './config';
import { install } from './service/index';
import type { Method, Params, Result } from './protocol/index';

const USAGE = `usage: cancore-bot [--config <path>] <command>
  init                     create the keystore (mnemonic + passphrase prompted)
  unlock | lock            decrypt / wipe the key in the daemon
  status
  limits show | limits set <file.json>
  pause [reason] | resume
  withdraw --to <party>    only the owner party pinned in config
  audit verify
  install [--human <user>] [--exec <path>] [--dry-run]`;

/** Reads one line from the TTY without echoing it. Refuses a non-TTY so secrets never come from a pipe or argv. */
export async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('a TTY is required to enter secrets');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s) => {
    if (!muted) process.stdout.write(s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function rpc<M extends Method>(config: BotConfig, method: M, params: Params<M>): Promise<Result<M>> {
  const client = await connect(config.ownerSocket);
  try {
    return await client.call(method, params);
  } finally {
    client.close();
  }
}

const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

export async function main(argv: string[]): Promise<number> {
  const config = loadConfig(flag(argv, 'config'));
  const args = argv.filter((a, i) => a !== '--config' && argv[i - 1] !== '--config');
  const [cmd, sub, arg] = args;
  try {
    switch (cmd) {
      case 'init': {
        const mnemonic = await promptSecret('mnemonic: ');
        const passphrase = await promptSecret('passphrase: ');
        if (passphrase !== (await promptSecret('repeat passphrase: '))) throw new Error('passphrases do not match');
        const keystore = createKeystore(paths(config).keystore);
        await keystore.init(mnemonic.trim(), passphrase);
        print({ publicKey: await keystore.publicKey() });
        return 0;
      }
      case 'unlock':
        print(await rpc(config, 'unlock', { passphrase: await promptSecret('passphrase: ') }));
        return 0;
      case 'lock':
        print(await rpc(config, 'lock', {}));
        return 0;
      case 'status':
        print(await rpc(config, 'status', {}));
        return 0;
      case 'pause':
        print(await rpc(config, 'pause', sub ? { reason: args.slice(1).join(' ') } : {}));
        return 0;
      case 'resume':
        print(await rpc(config, 'resume', {}));
        return 0;
      case 'limits':
        if (sub === 'show') return print(await rpc(config, 'limits.get', {})), 0;
        if (sub === 'set' && arg) return print(await rpc(config, 'limits.set', { limits: JSON.parse(readFileSync(arg, 'utf8')) as Record<string, unknown> })), 0;
        break;
      case 'withdraw': {
        const to = flag(args, 'to');
        if (!config.ownerParty) throw new Error('no ownerParty pinned in config; withdraw is disabled');
        if (to !== config.ownerParty) throw new Error(`withdraw only to the pinned owner party ${config.ownerParty}`);
        // shortcut: the protocol has no withdraw method yet; add one (owner class) before this can move funds.
        throw new Error('withdraw is not supported by this daemon version');
      }
      case 'audit':
        if (sub === 'verify') {
          const result = await (await openAuditLog(paths(config).audit)).verify();
          print(result);
          return result.ok ? 0 : 3;
        }
        break;
      case 'install':
        await install({
          user: config.daemonUser,
          clientsGroup: config.clientsGroup,
          execPath: flag(args, 'exec') ?? process.argv[1]!.replace(/cli\.js$|cancore-bot$/, (m) => (m === 'cli.js' ? 'daemon.js' : 'cancore-botd')),
          ...(flag(args, 'human') && { human: flag(args, 'human') }),
          dryRun: args.includes('--dry-run'),
        });
        return 0;
    }
    process.stderr.write(`${USAGE}\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`cancore-bot: ${err instanceof RpcCallError ? `${err.error.code} ${err.message}` : (err as Error).message}\n`);
    return 1;
  }
}

// shortcut: argv-based entry detection because jest runs this as CJS (no import.meta); breaks if the bin is renamed.
if (/(?:cancore-bot|cli\.js)$/.test(process.argv[1] ?? '')) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
