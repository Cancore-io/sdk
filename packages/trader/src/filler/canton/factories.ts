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
};

/** By instrument admin party. */
export const CANTON_TRANSFER_FACTORIES: Readonly<Record<string, readonly CantonTransferFactory[]>> = {
  // dev: the CNRX registrar (gitops k8s/envs/dev CNRX_REGISTRY_ADMIN_PARTY).
  'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b': [CNRX_REGISTRY_0_2_3],
};

/**
 * The allocation templates a Canton-source give may be committed in (V-C4),
 * by instrument admin, as `<package id>:<module>:<entity>`: the V2 allocation
 * of each pinned registry that has one.
 */
export const CANTON_ALLOCATION_TEMPLATES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(CANTON_TRANSFER_FACTORIES).map(([admin, factories]) => [admin, factories.flatMap((f) => (f.allocation ? [`${f.packageId}:${f.allocation}`] : []))]),
);
