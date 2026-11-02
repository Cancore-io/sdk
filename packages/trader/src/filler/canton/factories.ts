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
 * un-vetted). CC's entry is the `splice-amulet` DevNet runs (CAN-2931).
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
  /**
   * How the holding reads (CAN-2931): `view` (default) — the token standard's `HoldingView` under `holdingView`;
   * `amulet` — Splice's `Amulet`: `dso`, `owner`, `initialAmount` of the record under `holdingView` (`amount`),
   * instrument `{dso, "Amulet"}`, never locked (a locked one is another template, `LockedAmulet`);
   * `utility` — DA Utilities' `Holding`, no view: `owner`, `instrument` `{source, id}` (`source` the admin),
   * `amount`, `lock` (optional).
   */
  holdingForm?: 'view' | 'amulet' | 'utility';
  /** The package of `holding` when it is not `packageId` (DA Utilities: `utility-registry-holding-v0`). */
  holdingPackageId?: string;
  /**
   * A template of `packageId` the transfer is exercised on besides `factory`: DA Utilities answers a transfer to a
   * receiver with its preapproval by naming that `TransferPreapproval` as the factory, and only that path credits
   * the receiver at once — the `AllocationFactory` path always leaves an offer.
   */
  directFactory?: string;
  /**
   * Records the transfer creates with the sender as an observer, never as a signatory — `<packageId>:<module>:<entity>`,
   * of any package: DA Utilities keeps an `ExecutedTransfer` in `utility-registry-v0` for each transfer.
   */
  transferRecords?: readonly string[];
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
   * `instrumentAllowances` (`{id}`), no validity window;
   * `splice` (CC) — the party signs only a `TransferPreapprovalProposal`
   * (`receiver`, `provider`, `expectedDso`); its provider accepts it into the
   * `TransferPreapproval` and pays for it, so the node never signs the
   * preapproval itself.
   */
  preapprovalForm?: 'cnrx' | 'utility' | 'splice';
  /** The package of `preapproval` when it is not `packageId` (Splice: `splice-wallet`, not `splice-amulet`). */
  preapprovalPackageId?: string;
  /**
   * The provider a `splice` proposal must name, pinned per environment: it signs and pays for the preapproval,
   * and only a provider that accepts proposals makes one. Required with `preapprovalForm: 'splice'`.
   */
  preapprovalProvider?: string;
  /**
   * The DA Utilities operator the `utility` preapproval must name, pinned per environment: DA's registry sees
   * only a preapproval of its own operator, so one of any other leaves incoming transfers pending (CAN-2931).
   * Required with `preapprovalForm: 'utility'`.
   */
  preapprovalOperator?: string;
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
 * receiver and DA's operator, backend utility-registry-package.resolver.ts). The factory, offer and preapproval
 * are as the stand spike decoded a CBTC `TransferFactory_Transfer` (sdk test da-utility-transfer, CAN-2931).
 * The holding lives in `utility-registry-holding-v0` 0.8.2 (meta `dars/utility/packages.json`).
 */
const DA_UTILITY_REGISTRY_APP_0_8_2: CantonTransferFactory = {
  packageId: '2293eb12e82ceaeb3ff7f8fe3346dece8578e1e9fd7d46624aeb7bb07fa31eda',
  factory: 'Utility.Registry.App.V0.Service.AllocationFactory:AllocationFactory',
  holding: 'Utility.Registry.Holding.V0.Holding:Holding',
  holdingView: 'holding',
  holdingForm: 'utility',
  holdingPackageId: '71fbaea211f07a65666892748498bd4a0d7462a9d75bbb215ba9fbdbba78efa7',
  directFactory: 'Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval',
  // utility-registry-v0 0.7.1 (meta `dars/utility/packages.json`); signatory DA's operator, observers the two parties.
  transferRecords: ['1f80e086e9ce218cf93fdeed80943793e902ac35c521733d7373a5ba58813150:Utility.Registry.V0.Holding.Transfer:ExecutedTransfer'],
  offer: 'Utility.Registry.App.V0.Model.Transfer:TransferOffer',
  serviceChoices: [],
  // Signatory the receiver, observer DA's operator; transfers to the receiver complete at once.
  preapproval: 'Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval',
  preapprovalForm: 'utility',
};

/** devnet: DA's operator decoded from the devnet CBTC registrar's AllocationFactory (backend utility-preapproval.constants.ts). */
const DA_UTILITY_REGISTRY_APP_0_8_2_DEVNET: CantonTransferFactory = {
  ...DA_UTILITY_REGISTRY_APP_0_8_2,
  preapprovalOperator: 'auth0_007c65f857f1c3d599cb6df73775::1220d2d732d042c281cee80f483ab80f3cbaa4782860ed5f4dc228ab03dedd2ee8f9',
};

/**
 * Splice `splice-amulet` 0.1.24, the version of Splice 0.9.x that DevNet runs (canton-network/splice
 * `daml/dars.lock`; DevNet scan's `AmuletRules` and `OpenMiningRound` are of this package, 28.10.2026). The
 * factory contract was created at 0.1.9 and is exercised as 0.1.24 by upgrade. A direct transfer
 * (`TransferPreapproval_SendV2`, `ExternalPartyAmuletRules.daml`) archives the sender's input amulets and creates
 * the receiver's amulet, the sender's change, a `FeaturedAppActivityMarker` for the preapproval's provider and an
 * event-log entry of the DSO's — nothing else of the sender's. A transfer without the receiver's preapproval locks
 * the amount in a `LockedAmulet` of the sender, which the check refuses: CC is only ever sent direct.
 */
const SPLICE_AMULET_0_1_24: CantonTransferFactory = {
  packageId: '17b6f7c18efec9022dde39a19039783c68490a722e8a5088b22ee034678171a2',
  factory: 'Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules',
  holding: 'Splice.Amulet:Amulet',
  holdingView: 'amount',
  holdingForm: 'amulet',
  offer: 'Splice.AmuletTransferInstruction:AmuletTransferInstruction',
  serviceChoices: [],
  // splice-wallet 0.1.25 (Splice 0.9.x): `TransferPreapprovalProposal`, signatory the receiver, observer the provider.
  preapproval: 'Splice.Wallet.TransferPreapproval:TransferPreapprovalProposal',
  preapprovalForm: 'splice',
  preapprovalPackageId: '916f16ea9413ba72d9ae660c9d0741f1078fc27b82b61e4b9db6a991dc47a848',
};

/** devnet: the provider is the venue, which accepts the proposal and pays for it (backend venue-paid-preapproval.flow.ts). */
const SPLICE_AMULET_0_1_24_DEVNET: CantonTransferFactory = {
  ...SPLICE_AMULET_0_1_24,
  preapprovalProvider: 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b',
};

/** By instrument admin party. */
export const CANTON_TRANSFER_FACTORIES: Readonly<Record<string, readonly CantonTransferFactory[]>> = {
  // dev: the CNRX registrar (gitops k8s/envs/dev CNRX_REGISTRY_ADMIN_PARTY).
  'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b': [CNRX_REGISTRY_0_2_3],
  // devnet: CBTC's registrar on DA Utilities dev (backend libs/common/src/config/cbtc.config.ts).
  'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff': [DA_UTILITY_REGISTRY_APP_0_8_2_DEVNET],
  // devnet: the DSO, CC's admin (DevNet scan `registry/metadata/v1/info`).
  'DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a': [SPLICE_AMULET_0_1_24_DEVNET],
};

const PACKAGE_ID = /^[0-9a-f]{64}$/;
const PARTY_ID = /^[^\s:]+::1220[0-9a-f]{64}$/;
const QUALIFIED = /^[A-Za-z0-9_.]+:[A-Za-z0-9_]+$/;
const FULL_TEMPLATE = /^[0-9a-f]{64}:[A-Za-z0-9_.]+:[A-Za-z0-9_]+$/;

/**
 * Why `registries` is not a usable registry pin — `field: problem` — or
 * undefined when it is one: each admin a party id, each entry a 64-hex package
 * id with `<module>:<entity>` templates. For a stand with its own registrar
 * (`CantonConfig.registries`); never taken from filler-gateway.
 */
export function registriesProblem(registries: unknown): string | undefined {
  if (typeof registries !== 'object' || registries === null || Array.isArray(registries)) return ': expected an object by instrument admin';
  for (const [admin, entries] of Object.entries(registries as Record<string, unknown>)) {
    if (!PARTY_ID.test(admin)) return `[${admin}]: not a party id`;
    if (!Array.isArray(entries) || entries.length === 0) return `[${admin}]: expected a non-empty list`;
    for (const [i, e] of entries.entries()) {
      const problem = entryProblem(e as Partial<CantonTransferFactory> | null, `[${admin}][${i}]`);
      if (problem) return problem;
    }
  }
  return undefined;
}

const optionalTemplate = (v: unknown): boolean => v === undefined || (typeof v === 'string' && QUALIFIED.test(v));

function entryProblem(f: Partial<CantonTransferFactory> | null, at: string): string | undefined {
  if (typeof f !== 'object' || f === null) return `${at}: expected an object`;
  if (typeof f.packageId !== 'string' || !PACKAGE_ID.test(f.packageId)) return `${at}.packageId: expected 64 lowercase hex`;
  for (const k of ['factory', 'holding', 'offer'] as const) if (typeof f[k] !== 'string' || !QUALIFIED.test(f[k] as string)) return `${at}.${k}: expected <module>:<entity>`;
  if (typeof f.holdingView !== 'string' || f.holdingView.length === 0) return `${at}.holdingView: expected a field name`;
  if (!Array.isArray(f.serviceChoices) || !f.serviceChoices.every((c) => typeof c === 'string')) return `${at}.serviceChoices: expected a list of <module>:<entity>.<choice>`;
  for (const k of ['allocation', 'preapproval', 'directFactory'] as const) if (!optionalTemplate(f[k])) return `${at}.${k}: expected <module>:<entity>`;
  if (f.transferRecords !== undefined && (!Array.isArray(f.transferRecords) || !f.transferRecords.every((t) => typeof t === 'string' && FULL_TEMPLATE.test(t)))) return `${at}.transferRecords: expected a list of <packageId>:<module>:<entity>`;
  if (f.openReceipt !== undefined && typeof f.openReceipt !== 'boolean') return `${at}.openReceipt: expected a boolean`;
  if (f.holdingForm !== undefined && f.holdingForm !== 'view' && f.holdingForm !== 'amulet' && f.holdingForm !== 'utility') return `${at}.holdingForm: expected view, amulet or utility`;
  if (f.holdingPackageId !== undefined && (typeof f.holdingPackageId !== 'string' || !PACKAGE_ID.test(f.holdingPackageId))) return `${at}.holdingPackageId: expected 64 lowercase hex`;
  if (f.preapprovalForm !== undefined && f.preapprovalForm !== 'cnrx' && f.preapprovalForm !== 'utility' && f.preapprovalForm !== 'splice') return `${at}.preapprovalForm: expected cnrx, utility or splice`;
  if (f.preapprovalPackageId !== undefined && (typeof f.preapprovalPackageId !== 'string' || !PACKAGE_ID.test(f.preapprovalPackageId))) return `${at}.preapprovalPackageId: expected 64 lowercase hex`;
  if (f.preapprovalForm === 'utility' && (typeof f.preapprovalOperator !== 'string' || !PARTY_ID.test(f.preapprovalOperator))) return `${at}.preapprovalOperator: expected the DA operator's party id`;
  if (f.preapprovalForm === 'splice' && (typeof f.preapprovalProvider !== 'string' || !PARTY_ID.test(f.preapprovalProvider))) return `${at}.preapprovalProvider: expected the provider's party id`;
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
