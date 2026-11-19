import * as root from '../index';
import * as web from './index';

// The browser entry: a change to this list is a deliberate edit, never a side effect of an `export *`.
const WEB = ['clearPersistedWallet', 'deleteWalletAccount', 'evalPrf', 'getPersistedWallet', 'isWebAuthnSupported', 'listWalletAccounts', 'putPersistedWallet', 'putWalletAccount', 'registerPasskey'];

describe('CAN-867: the public surface of @cancore/wallet/web', () => {
  test('TC-CAN-867-05: ./web exports exactly its pinned list, each a callable function', () => {
    expect(Object.keys(web).sort()).toEqual([...WEB].sort());
    for (const name of WEB) expect(typeof (web as Record<string, unknown>)[name]).toBe('function');
  });

  test('TC-CAN-867-06: ./web and the root entry share no name', () => {
    expect(Object.keys(web).filter((n) => n in root)).toEqual([]);
  });
});
