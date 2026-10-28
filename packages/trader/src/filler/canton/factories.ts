/**
 * The transfer factories a filler party's holdings may move through
 * (`holdings.transfer`, sdk#105 review): a closed list keyed by the
 * instrument admin, each entry pinned to the package id and template of the
 * factory, with the templates of the holdings and pending transfers it
 * creates. The backend chooses the factory contract; the node accepts it only
 * when its template is one of these. An admin with no entry, or a factory of
 * another package or template, is refused: no transfer goes through a factory
 * the node has not pinned.
 *
 * Seeded from the registry packages actually delivered, read from the
 * published DARs, never from a ledger: cnrx-registry 0.2.3 is
 * `canton-contracts` `deploy-contracts/dars/cnrx-registry-0.2.3.dar`
 * (commit 8120c32, CAN-2570), the only version dev vets (0.2.0–0.2.2 are
 * un-vetted). CC and the Utility Registry tokens have no entry yet: their
 * package ids are in no published configuration of ours, so a transfer of
 * them is refused until an entry is added here.
 */

/** A pinned transfer factory and what it creates. Templates are `<module>:<entity>` within `packageId`. */
export interface CantonTransferFactory {
  /** Package id of the registry package the factory, its holdings and its pending transfers come from. */
  packageId: string;
  /** The factory template the root `TransferFactory_Transfer` is exercised on. */
  factory: string;
  /** The holding template; its create argument holds the token standard's `HoldingView` under `holdingView`. */
  holding: string;
  holdingView: string;
  /** The pending transfer created when the receiver has no preapproval; its argument holds the transfer under `transfer`. */
  offer: string;
  /**
   * Choices besides archiving a stated input that the factory may exercise on
   * a contract the sender is a stakeholder of, as `<module>:<entity>.<choice>`.
   */
  serviceChoices: readonly string[];
  /** The V2 allocation template the registry's allocation factory creates, when the registry has one (V-C4). */
  allocation?: string;
  /**
   * The registry's receipt-only allocation needs nothing from its receiver — no
   * holding, no preapproval, no other contract of the receiver's — so any party
   * can be paid through it (fillers.md T-9, V-C5). Set only from the registry's
   * own code; a registry without it is not paid out to on a Canton source.
   */
  openReceipt?: boolean;
  /**
   * The registry's transfer preapproval template, signed by its receiver: what
   * `preapproval.create` may create for the party (CAN-2904). A registry
   * without it gets no preapproval from the node.
   */
  preapproval?: string;
  /**
   * How the preapproval reads (CAN-2931): `cnrx` (default) — fields `admin`,
   * `receiver`, `instrumentAllowances` (ids), `requestedAt`, `executeBefore`;
   * `utility` (DA Utilities) — `operator`, `receiver`, `instrumentAdmin`,
   * `instrumentAllowances` (`{id}`), no validity window.
   */
  preapprovalForm?: 'cnrx' | 'utility';
}

const CNRX_REGISTRY_0_2_3: CantonTransferFactory = {
  packageId: 'd495b7d2e9376e42bb58845c47e165492bba917216352636b6c357c76d3bb736',
  factory: 'Cnrx.Rules:CnrxRules',
  holding: 'Cnrx.Holding:CnrxHolding',
  holdingView: 'holding',
  offer: 'Cnrx.Transfer:CnrxTransferOffer',
  // The CNRX transfer body exercises nothing on the sender's contracts but the archive of its inputs.
  serviceChoices: [],
  // Committed V2 allocations from 0.2.1 on (CAN-2415).
  allocation: 'Cnrx.Allocation:CnrxAllocationV2',
  // Cnrx.Allocation cnrx_allocateImplV2: a receipt-only allocation (no debit) takes no input holdings and
  // checks only that its actor owns the authorizer account — nothing of the receiver must exist beforehand.
  openReceipt: true,
  // Cnrx.Transfer: signatory receiver, observer admin; transfers to the receiver complete at once.
  preapproval: 'Cnrx.Transfer:CnrxTransferPreapproval',
};

/**
 * DA Utilities `utility-registry-app-v0` 0.8.2 (meta `dars/utility/packages.json`; the version dev vets for a
 * receiver and DA's operator, backend utility-registry-package.resolver.ts). Only the preapproval is pinned for
 * a delivery yet: `factory`, `holding` and `offer` are the templates the stand's DA DARs carry, and a transfer
 * through them is still refused by the holding check (the holding lives in `utility-registry-holding-v0`) until
 * the transfer's shape is pinned from the stand spike (sdk test da-utility-transfer, CAN-2931).
 */
const DA_UTILITY_REGISTRY_APP_0_8_2: CantonTransferFactory = {
  packageId: '2293eb12e82ceaeb3ff7f8fe3346dece8578e1e9fd7d46624aeb7bb07fa31eda',
  factory: 'Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval',
  holding: 'Utility.Registry.Holding.V0.Holding:Holding',
  holdingView: 'holding',
  offer: 'Utility.Registry.App.V0.Model.Transfer:TransferOffer',
  serviceChoices: [],
  // Signatory the receiver, observer DA's operator; transfers to the receiver complete at once.
  preapproval: 'Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval',
  preapprovalForm: 'utility',
};

/** By instrument admin party. */
export const CANTON_TRANSFER_FACTORIES: Readonly<Record<string, readonly CantonTransferFactory[]>> = {
  // dev: the CNRX registrar (gitops k8s/envs/dev CNRX_REGISTRY_ADMIN_PARTY).
  'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b': [CNRX_REGISTRY_0_2_3],
  // devnet: CBTC's registrar on DA Utilities dev (backend libs/common/src/config/cbtc.config.ts).
  'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff': [DA_UTILITY_REGISTRY_APP_0_8_2],
};

const PACKAGE_ID = /^[0-9a-f]{64}$/;
const QUALIFIED = /^[A-Za-z0-9_.]+:[A-Za-z0-9_]+$/;

/**
 * Why `registries` is not a usable registry pin — `field: problem` — or
 * undefined when it is one: each admin a party id, each entry a 64-hex package
 * id with `<module>:<entity>` templates. For a stand with its own registrar
 * (`CantonConfig.registries`); never taken from filler-gateway.
 */
export function registriesProblem(registries: unknown): string | undefined {
  if (typeof registries !== 'object' || registries === null || Array.isArray(registries)) return ': expected an object by instrument admin';
  for (const [admin, entries] of Object.entries(registries as Record<string, unknown>)) {
    if (!/^[^\s:]+::1220[0-9a-f]{64}$/.test(admin)) return `[${admin}]: not a party id`;
    if (!Array.isArray(entries) || entries.length === 0) return `[${admin}]: expected a non-empty list`;
    for (const [i, e] of entries.entries()) {
      const f = e as Partial<CantonTransferFactory> | null;
      const at = `[${admin}][${i}]`;
      if (typeof f !== 'object' || f === null) return `${at}: expected an object`;
      if (typeof f.packageId !== 'string' || !PACKAGE_ID.test(f.packageId)) return `${at}.packageId: expected 64 lowercase hex`;
      for (const k of ['factory', 'holding', 'offer'] as const) if (typeof f[k] !== 'string' || !QUALIFIED.test(f[k] as string)) return `${at}.${k}: expected <module>:<entity>`;
      if (typeof f.holdingView !== 'string' || f.holdingView.length === 0) return `${at}.holdingView: expected a field name`;
      if (!Array.isArray(f.serviceChoices) || !f.serviceChoices.every((c) => typeof c === 'string')) return `${at}.serviceChoices: expected a list of <module>:<entity>.<choice>`;
      if (f.allocation !== undefined && (typeof f.allocation !== 'string' || !QUALIFIED.test(f.allocation))) return `${at}.allocation: expected <module>:<entity>`;
      if (f.openReceipt !== undefined && typeof f.openReceipt !== 'boolean') return `${at}.openReceipt: expected a boolean`;
      if (f.preapproval !== undefined && (typeof f.preapproval !== 'string' || !QUALIFIED.test(f.preapproval))) return `${at}.preapproval: expected <module>:<entity>`;
      if (f.preapprovalForm !== undefined && f.preapprovalForm !== 'cnrx' && f.preapprovalForm !== 'utility') return `${at}.preapprovalForm: expected cnrx or utility`;
    }
  }
  return undefined;
}

/**
 * The allocation templates a Canton-source give may be committed in (V-C4),
 * by instrument admin, as `<package id>:<module>:<entity>`: the V2 allocation
 * of each pinned registry that has one.
 */
export const CANTON_ALLOCATION_TEMPLATES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(CANTON_TRANSFER_FACTORIES).map(([admin, factories]) => [admin, factories.flatMap((f) => (f.allocation ? [`${f.packageId}:${f.allocation}`] : []))]),
);
