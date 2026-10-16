import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULTS, loadConfig } from './config';

const file = (body: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), 'botd-config-')), 'config.json');
  writeFileSync(path, JSON.stringify(body), { mode: 0o644 });
  return path;
};

describe('loadConfig', () => {
  it('fills defaults under the fields the file sets', () => {
    expect(loadConfig(file({ network: 'devnet', ordersPerHour: 3 }))).toEqual({ ...DEFAULTS, network: 'devnet', ordersPerHour: 3 });
  });

  it('refuses a misspelt key and a wrong type instead of ignoring them', () => {
    expect(() => loadConfig(file({ venuePartyID: 'x' }))).toThrow(/config:.*venuePartyID/);
    expect(() => loadConfig(file({ ordersPerHour: '5' }))).toThrow(/config: ordersPerHour/);
    expect(() => loadConfig(file({ ownerParty: 42 }))).toThrow(/config: ownerParty/);
  });

  it('refuses a config writable by group or others, and a symlink', () => {
    const path = file({ network: 'devnet' });
    chmodSync(path, 0o664);
    expect(() => loadConfig(path)).toThrow(/writable by group or others/);
    chmodSync(path, 0o644);
    const link = `${path}.link`;
    symlinkSync(path, link);
    expect(() => loadConfig(link)).toThrow();
  });
});
