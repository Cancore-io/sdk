import { install, installPlan, systemdUnit } from './index';

const opts = { user: 'cancore-bot', clientsGroup: 'cancore-bot-clients', execPath: '/usr/lib/node_modules/@cancore/botd/dist/daemon.js', nodePath: '/usr/bin/node' };

describe('service', () => {
  it('renders the hardened unit', () => {
    const unit = systemdUnit(opts);
    for (const line of [
      'User=cancore-bot',
      'Group=cancore-bot',
      'SupplementaryGroups=cancore-bot-clients',
      'RuntimeDirectory=cancore-bot',
      'StateDirectory=cancore-bot',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'NoNewPrivileges=yes',
      'LimitCORE=0',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
      'CapabilityBoundingSet=',
      'SystemCallFilter=@system-service',
      `ExecStart=/usr/bin/node ${opts.execPath}`,
    ])
      expect(unit.split('\n')).toContain(line);
    expect(unit).not.toMatch(/^MemoryDenyWriteExecute/m);
  });

  it('plans group, user, membership, dirs, unit, reload', () => {
    expect(installPlan({ ...opts, human: 'alice' }).map((s) => s.join(' '))).toEqual([
      'getent group cancore-bot-clients || groupadd --system cancore-bot-clients',
      'id cancore-bot || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin cancore-bot',
      'usermod -aG cancore-bot-clients alice',
      'install -d -m 0755 /etc/cancore-bot',
      'install -d -m 0700 -o cancore-bot -g cancore-bot /var/lib/cancore-bot',
      'write:/etc/systemd/system/cancore-botd.service',
      'systemctl daemon-reload',
    ]);
  });

  it('refuses without root unless dry-run', async () => {
    if (process.getuid?.() === 0) return;
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(install(opts)).rejects.toThrow(/root/);
      await expect(install({ ...opts, dryRun: true })).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });
});
