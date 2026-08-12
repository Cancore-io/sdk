import { CancoreProvider, type CancoreProviderOptions } from './provider';
import type { Cip0103Provider } from './types';

/**
 * How PartyLayer reaches us (CAN-779).
 *
 * Of the three ways into their picker, exactly one fits a wallet that is a web
 * app with the key in the user's browser:
 *
 * - `injected` — the SDK scans `window.canton`. Needs a browser extension.
 * - `announce` — the wallet fires `canton:announceProvider` on the dApp's page.
 *   Same requirement: something of ours has to be running there already.
 * - `discovery-adapter` — the registry entry names a `providerId` and a
 *   network→host map, and the dApp passes an adapter object with that id into
 *   `createPartyLayer({adapters: […]})`. Their `GenericDiscoveryAdapter` then
 *   drives it: `factory.create(host)` → `detect()` → `provider()` →
 *   `request({method:'connect'})` → `getPrimaryAccount` → `status`.
 *
 * So the registry entry alone is inert for us: without this object in the
 * dApp's bundle there is nothing for the picker to call. The shape below is
 * upstream's `ProviderAdapter` (`@canton-network/core-wallet-discovery`), which
 * PartyLayer duck-types rather than imports — so neither package is a
 * dependency here.
 */

/** `WalletInfo` of `@canton-network/core-wallet-discovery`, the fields we fill. */
export interface CancoreWalletInfo {
  providerId: string;
  name: string;
  type: 'remote';
  description: string;
  icon: string;
  url: string;
}

export interface CancoreAdapter {
  readonly providerId: string;
  readonly name: string;
  readonly type: 'remote';
  readonly icon: string;
  getInfo(): CancoreWalletInfo;
  detect(): Promise<boolean>;
  provider(): Cip0103Provider;
  teardown(): void;
}

// Our own copy on purpose. The registry entry points at PartyLayer's CDN copy
// instead, because their `gate:wallet-marks` requires the mark to live in
// `registry/wallets/`; a picker driven by this adapter alone should not depend
// on their hosting.
const ICON = 'https://cancore.io/favicon-512x512.png';

const INFO: CancoreWalletInfo = {
  providerId: 'cancore',
  name: 'Cancore',
  type: 'remote',
  description: 'Self-custody Canton wallet. Keys stay in the browser; the server never signs.',
  icon: ICON,
  url: 'https://cancore.io',
};

/** Registry `adapter.config.providerId`. Changing it unlists the wallet. */
export const CANCORE_PROVIDER_ID = 'cancore';

export type AdapterOptions = Omit<CancoreProviderOptions, 'host'>;

/**
 * The factory form, because the host is per network and upstream adapters seal
 * it at construction: PartyLayer resolves `networkHosts[network]` from our
 * registry entry and calls `create(host)` with it, so no Cancore URL is
 * hardcoded in anybody's SDK or app code.
 */
export function cancoreAdapterFactory(options: AdapterOptions = {}) {
  return {
    providerId: CANCORE_PROVIDER_ID,
    name: INFO.name,
    icon: ICON,
    create(host: string): CancoreAdapter {
      let provider: CancoreProvider | null = null;
      return {
        providerId: CANCORE_PROVIDER_ID,
        name: INFO.name,
        type: 'remote',
        icon: ICON,
        getInfo: () => INFO,
        /**
         * Nothing to install and nothing to probe without opening a window —
         * and this call is documented as popup-free. A hosted wallet is
         * available in the only sense the picker asks about; whether the user
         * has an account is what `connect` finds out.
         */
        detect: () => Promise.resolve(true),
        provider: () => (provider ??= new CancoreProvider({ ...options, host })),
        teardown: () => {
          provider?.close();
          provider = null;
        },
      };
    },
  };
}
