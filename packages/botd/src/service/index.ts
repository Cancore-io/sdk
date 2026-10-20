import { execFileSync } from 'child_process';
import { realpathSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface ServiceOptions {
  /** Daemon user and its primary group. */
  user: string;
  /** Group whose members may use the agent socket. */
  clientsGroup: string;
  /** Path to the cancore-botd executable. */
  execPath: string;
  /** Node binary; default the one running now. */
  nodePath?: string;
}

export const UNIT_PATH = '/etc/systemd/system/cancore-botd.service';

/**
 * Renders the hardened systemd unit for cancore-botd.
 *
 * No MemoryDenyWriteExecute: V8's JIT maps W+X pages and node exits at start
 * under it (checked on node 24); `--jitless` would pass but disables
 * WebAssembly and slows signing, so the JIT stays and MDWE goes.
 */
export function systemdUnit(options: ServiceOptions): string {
  return `[Unit]
Description=Cancore self-custody trading daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${options.user}
Group=${options.user}
# Needed to chown the agent socket to the clients group.
SupplementaryGroups=${options.clientsGroup}
ExecStart=${options.nodePath ?? process.execPath} ${options.execPath}
Restart=on-failure
UMask=0077
RuntimeDirectory=cancore-bot
# Traverse-only: socket file modes decide who connects.
RuntimeDirectoryMode=0711
StateDirectory=cancore-bot
StateDirectoryMode=0700
ConfigurationDirectory=cancore-bot
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes
LimitCORE=0
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallFilter=@system-service
SystemCallArchitectures=native
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ProtectProc=invisible
ProtectKernelLogs=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
PrivateIPC=yes
RemoveIPC=yes
KeyringMode=private
SystemCallFilter=~@privileged

[Install]
WantedBy=multi-user.target
`;
}

/** The commands install runs, in order. `write:<path>` writes the unit file. */
export function installPlan(options: ServiceOptions & { human?: string }): string[][] {
  const { user, clientsGroup, human } = options;
  return [
    ['getent', 'group', clientsGroup, '||', 'groupadd', '--system', clientsGroup],
    ['id', user, '||', 'useradd', '--system', '--user-group', '--no-create-home', '--shell', '/usr/sbin/nologin', user],
    ...(human ? [['usermod', '-aG', clientsGroup, human]] : []),
    ['install', '-d', '-m', '0755', '/etc/cancore-bot'],
    ['install', '-d', '-m', '0700', '-o', user, '-g', user, '/var/lib/cancore-bot'],
    [`write:${UNIT_PATH}`],
    ['systemctl', 'daemon-reload'],
  ];
}

/**
 * The unit runs `node daemon.js` as the daemon user, which later receives the passphrase: a file on
 * that path, or a directory above it, that a non-root user can rewrite would hand them the key.
 */
/** Returns the resolved path: the unit must name it, not a link that could be re-pointed later. */
export function assertRootOwnedChain(path: string, fs: { realpath(p: string): string; stat(p: string): { uid: number; mode: number } } = { realpath: realpathSync, stat: statSync }): string {
  const resolved = fs.realpath(path);
  let p = resolved;
  for (;;) {
    const st = fs.stat(p);
    if (st.uid !== 0) throw new Error(`${p} is owned by uid ${st.uid}: install cancore-botd and node where only root can write`);
    if (st.mode & 0o022) throw new Error(`${p} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    if (p === dirname(p)) return resolved;
    p = dirname(p);
  }
}

/** Creates the user, group and directories and installs the unit; needs root unless dryRun, which only prints. */
export async function install(options: ServiceOptions & { human?: string; dryRun?: boolean }): Promise<void> {
  if (!options.dryRun && process.getuid?.() !== 0) throw new Error('install must run as root (or pass --dry-run)');
  if (!options.dryRun) {
    options = { ...options, nodePath: assertRootOwnedChain(options.nodePath ?? process.execPath), execPath: assertRootOwnedChain(options.execPath) };
  }
  const plan = installPlan(options);
  for (const step of plan) {
    const [first, ...rest] = step;
    if (first!.startsWith('write:')) {
      const path = first!.slice('write:'.length);
      process.stdout.write(`# write ${path}\n`);
      if (options.dryRun) process.stdout.write(systemdUnit(options));
      else writeFileSync(path, systemdUnit(options), { mode: 0o644 });
      continue;
    }
    const line = step.join(' ');
    process.stdout.write(`${line}\n`);
    if (options.dryRun) continue;
    // `a || b`: run b only when a fails; the only shell-ish form in the plan.
    const or = step.indexOf('||');
    if (or < 0) execFileSync(first!, rest, { stdio: 'inherit' });
    else {
      try {
        execFileSync(step[0]!, step.slice(1, or), { stdio: 'ignore' });
      } catch {
        execFileSync(step[or + 1]!, step.slice(or + 2), { stdio: 'inherit' });
      }
    }
  }
  if (!options.dryRun) process.stdout.write('next: systemctl enable --now cancore-botd\n');
}
