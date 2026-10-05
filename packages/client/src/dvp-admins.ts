/**
 * The instrument admins a DvP allocation may run under, pinned in the SDK.
 *
 * An allocation's code is the code its admin deployed: the factory the allocation runs on must
 * be signed by the instrument admin, and nobody else can create such a contract. That makes the
 * admin the trust anchor, so it must not come from the API: `/htlc/dvp/instruments` names an
 * admin, and a trade is refused unless that admin is listed here for the instrument.
 *
 * One list per instrument, every network in it: a party id carries its own namespace, so a
 * devnet admin does not exist on mainnet and listing it there costs nothing. A network or token
 * missing here is refused until the caller adds it with `instrumentAdmins`.
 */
export const DEFAULT_INSTRUMENT_ADMINS: Record<string, string[]> = {
  // Canton Coin: the DSO party of each network.
  Amulet: [
    'DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a', // devnet
    'DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc', // mainnet
  ],
  CBTC: [
    'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff', // devnet
    'cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f', // testnet
    'cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262', // mainnet
  ],
  USDCx: [
    'decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61', // testnet
    'decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef', // mainnet
  ],
  HECTO: [
    'Hecto-Finance-1::12208ee00572aea3304ebb12e34320769ea4b421911c9b658a999e0e64ee8a070972', // mainnet
  ],
  // Test tokens of the dev stand.
  HTEST: ['test-token-1::122034faf8f4af71d107a42441f8bc90cabfd63ab4386fc7f17d15d6e3b01c5bd2ae'],
  cETH: ['rails-cethMain-1-dev::12200b6de051e66bacd250de4bc76292e9d0ef71b478d7c11e49799b8e26f853493e'],
};

/** CC is listed as CC or as its ledger name, Amulet. */
export const instrumentKey = (id: string) => (id === 'CC' ? 'Amulet' : id);

/** Lists merged entry by entry: an override adds to the defaults, it never drops them. */
export function mergeLists(base: Record<string, string[]>, extra: Record<string, string[]> = {}): Record<string, string[]> {
  const out: Record<string, string[]> = { ...base };
  for (const [key, values] of Object.entries(extra)) out[key] = [...new Set([...(out[key] ?? []), ...values])];
  return out;
}
