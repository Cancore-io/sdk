#!/usr/bin/env node
/** cancore-bot: the owner CLI. Talks to the owner socket, so run it as the daemon user: `sudo -u cancore-bot cancore-bot …`. */
import { randomInt } from 'crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { hexToBytes } from '@cancore/wallet';
import { connect, RpcCallError } from './ipc/client';
import { createKeystore, generateMnemonic } from './keystore';
import { openAuditLog } from './audit';
import { flag, loadConfig, paths, type BotConfig } from './config';
import { install } from './service/index';
import type { Method, Params, Result } from './protocol/index';

const USAGE = `usage: cancore-bot [--config <path>] <command>
  init                     create the keystore from a new 24-word phrase (shown once, then checked)
  init --import            ... from an existing phrase instead (never your wallet's)
  init --import-key <file> ... from the 64-hex key Cancore "My bots" gives (file mode 0600)
  unlock | lock            decrypt / wipe the key in the daemon
  register                 register the account (invite code prompted) and onboard its party
  status
  limits show | limits set <file.json>
  pause [reason] | resume
  withdraw --to <party> --instrument <id> --amount <n>
                           only to the owner party pinned in config
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
  return new Promise((resolve, reject) => {
    let answered = false;
    // Ctrl-D / EOF closes the interface without an answer: fail instead of hanging.
    rl.once('close', () => answered || reject(new Error('no input')));
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

/** Asks for `count` random words of the phrase back; throws on the first wrong one. */
export async function confirmBackup(mnemonic: string, ask: (question: string) => Promise<string>, pick = randomInt, count = 3): Promise<void> {
  const words = mnemonic.split(' ');
  const positions = new Set<number>();
  while (positions.size < count) positions.add(pick(words.length));
  for (const i of [...positions].sort((a, b) => a - b)) {
    if ((await ask(`word #${i + 1}: `)).trim().toLowerCase() !== words[i]) throw new Error('that word does not match; nothing was written, run init again');
  }
}

/** The 32-byte key from a file only this user can read: 64 hex characters, nothing else. */
export function readKeyFile(path: string): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (st.mode & 0o077) throw new Error(`${path} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${path} is not owned by the current user`);
    const hex = readFileSync(fd, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${path}: expected a 32-byte key as 64 hex characters`);
    return hexToBytes(hex.toLowerCase());
  } finally {
    closeSync(fd);
  }
}

/** Shows the new phrase once on the TTY, waits until it is written down, then clears the screen. */
async function showOnce(mnemonic: string): Promise<void> {
  if (!process.stdout.isTTY) throw new Error('a TTY is required to show the recovery phrase');
  const words = mnemonic.split(' ').map((w, i) => `${String(i + 1).padStart(2)}. ${w}`);
  process.stdout.write(`\nRecovery phrase of the bot's key. Write it down offline; it is shown once and is the only backup.\n\n`);
  for (let i = 0; i < words.length; i += 4) process.stdout.write(`  ${words.slice(i, i + 4).map((w) => w.padEnd(18)).join('')}\n`);
  await promptSecret('\npress Enter once it is written down ');
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
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
        const keyFile = flag(args, 'import-key');
        let seed: Uint8Array | undefined;
        let mnemonic: string | undefined;
        if (keyFile) {
          seed = readKeyFile(keyFile);
        } else if (args.includes('--import')) {
          process.stderr.write('warning: importing a phrase. Use one made for this bot, never your wallet\'s: account 0 of your wallet phrase is your wallet.\n');
          mnemonic = (await promptSecret('recovery phrase: ')).trim();
        } else {
          mnemonic = generateMnemonic();
          await showOnce(mnemonic);
          await confirmBackup(mnemonic, promptSecret);
        }
        try {
          const passphrase = await promptSecret('passphrase: ');
          if (passphrase !== (await promptSecret('repeat passphrase: '))) throw new Error('passphrases do not match');
          const keystore = createKeystore(paths(config).keystore);
          await (seed ? keystore.initSeed(seed, passphrase) : keystore.init(mnemonic!, passphrase));
          print({ publicKey: await keystore.publicKey() });
        } finally {
          seed?.fill(0);
        }
        return 0;
      }
      case 'register': {
        const inviteCode = (await promptSecret('invite code (Enter for none): ')).trim();
        print(await rpc(config, 'register', inviteCode ? { inviteCode } : {}));
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
        const [to, instrument, amount] = [flag(args, 'to'), flag(args, 'instrument'), flag(args, 'amount')];
        if (!to || !instrument || !amount) break;
        // The daemon refuses any `to` but the owner party pinned in its config.
        print(await rpc(config, 'withdraw', { to, instrument, amount }));
        return 0;
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
