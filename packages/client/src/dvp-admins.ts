/**
 * The instrument admins a DvP allocation may run under, pinned in the SDK per network.
 *
 * An allocation's code is the code its admin deployed: the factory the allocation runs on must
 * be signed by the instrument admin, and nobody else can create such a contract. That makes the
 * admin the trust anchor, so it must not come from the API: `/htlc/dvp/instruments` names an
 * admin, and a trade is refused unless that admin is listed here for the instrument on the
 * network the account trades on. Lists are per network because a party's namespace is a key
 * fingerprint, and its holder can register the same party on any synchronizer: a test network's
 * admin must not be trusted on mainnet.
 *
 * A network or token missing here is refused until the caller adds it with `instrumentAdmins`.
 */
export type DvpNetwork = 'devnet' | 'testnet' | 'mainnet';

/** Freeze an object and everything in it: a pinned list must not be editable at runtime by a dependency. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_INSTRUMENT_ADMINS: Readonly<Record<DvpNetwork, Readonly<Record<string, readonly string[]>>>> = deepFreeze({
  devnet: {
    Amulet: ['DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a'],
    CBTC: ['cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff'],
    // Test tokens of the dev stand.
    HTEST: ['test-token-1::122034faf8f4af71d107a42441f8bc90cabfd63ab4386fc7f17d15d6e3b01c5bd2ae'],
    cETH: ['rails-cethMain-1-dev::12200b6de051e66bacd250de4bc76292e9d0ef71b478d7c11e49799b8e26f853493e'],
  },
  testnet: {
    // CC: the testnet DSO party is not configured; pass it with instrumentAdmins.
    CBTC: ['cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f'],
    USDCx: ['decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61'],
  },
  mainnet: {
    Amulet: ['DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc'],
    CBTC: ['cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262'],
    USDCx: ['decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef'],
    HECTO: ['Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972'],
  },
});

/** The Cancore API hosts and the network each serves. Another host needs the `network` option. */
export const API_NETWORKS: Readonly<Record<string, DvpNetwork>> = Object.freeze({
  'api-dev.cancore.app': 'devnet',
  'api-testnet.cancore.app': 'testnet',
  'api.cancore.io': 'mainnet',
});

export function networkOf(baseUrl: string): DvpNetwork | undefined {
  try {
    return API_NETWORKS[new URL(baseUrl).hostname];
  } catch {
    return undefined;
  }
}

/** CC is listed as CC or as its ledger name, Amulet. */
export const instrumentKey = (id: string) => (id === 'CC' ? 'Amulet' : id);

/** Lists merged entry by entry: an override adds to the defaults, it never drops them. */
export function mergeLists(base: Readonly<Record<string, readonly string[]>>, extra: Readonly<Record<string, readonly string[]>> = {}): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v]]));
  for (const [key, values] of Object.entries(extra)) out[key] = [...new Set([...(out[key] ?? []), ...values])];
  return out;
}

/**
 * The venue party (settlement executor of every DvP allocation), pinned per network.
 *
 * Withdrawing one's own allocation must not wait on a stand endpoint: the venue is read from here, or
 * from the `venuePartyId` option, and never from `/htlc/fee-config`. Testnet is not pinned: pass
 * `venuePartyId`.
 */
export const DEFAULT_VENUES: Readonly<Record<DvpNetwork, string | null>> = Object.freeze({
  devnet: 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b',
  testnet: null,
  mainnet: 'Cancore-mainnet-1::1220076a94e0a7f0256a32ffab227db7788d8075677d8afcdaa8386df8f2fa659906',
});
