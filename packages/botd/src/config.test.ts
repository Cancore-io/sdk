import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULTS, loadConfig } from './config';

const file = (body: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), 'botd-config-')), 'config.json');
  writeFileSync(path, JSON.stringify(body));
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
});
