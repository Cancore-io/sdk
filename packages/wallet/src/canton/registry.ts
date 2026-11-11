import { CANTON_TRANSFER_FACTORIES, type CantonTransferFactory } from './factories';

/**
 * The closed list of registry package ids by instrument admin (CAN-3340): the packages whose
 * templates are the registry's own code — its factories, holdings and transfer records.
 * Derived from {@link CANTON_TRANSFER_FACTORIES}, so the list the filler node pins and the
 * one the wallet, the filler node and the attestor check factories against are one list.
 */
export type RegistryPackages = Readonly<Record<string, readonly string[]>>;

const packagesOf = (f: CantonTransferFactory): string[] => [
  f.packageId,
  ...(f.holdingPackageId ? [f.holdingPackageId] : []),
  ...(f.upgradedHoldingPackageIds ?? []),
  ...(f.transferRecords ?? []).map((template) => template.split(':')[0] ?? ''),
];

export function registryPackagesOf(factories: Readonly<Record<string, readonly CantonTransferFactory[]>>): RegistryPackages {
  return Object.fromEntries(Object.entries(factories).map(([admin, entries]) => [admin, [...new Set(entries.flatMap(packagesOf))]]));
}

export const REGISTRY_PACKAGES: RegistryPackages = registryPackagesOf(CANTON_TRANSFER_FACTORIES);

/** CAN-3132: by instrument admin, G — the CNRX guardian of the registry ({@link CantonTransferFactory.guardian}). */
export type RegistryGuardians = Readonly<Record<string, string>>;

export function registryGuardiansOf(factories: Readonly<Record<string, readonly CantonTransferFactory[]>>): RegistryGuardians {
  return Object.fromEntries(
    Object.entries(factories).flatMap(([admin, entries]) => {
      const guardian = entries.find((f) => f.guardian !== undefined)?.guardian;
      return guardian === undefined ? [] : [[admin, guardian]];
    }),
  );
}

export const REGISTRY_GUARDIANS: RegistryGuardians = registryGuardiansOf(CANTON_TRANSFER_FACTORIES);

/** A contract as a prepared transaction or a created event names it: `templateId` is `<package id>:<module>:<entity>`. */
export interface RegistryContract {
  templateId: string;
  signatories: readonly string[];
}

/** cnrx-registry's factory templates, `<module>:<entity>`: anchored on a guardian (CAN-3132). */
const CNRX_FACTORIES: ReadonlySet<string> = new Set(['Cnrx.Rules:CnrxRules', 'Cnrx.Allocation:CnrxAllocationRules']);

/**
 * Whether `contract` is the registry's of `admin`: the admin signs it, or its template is of
 * one of the admin's registry packages. An admin with no entry is refused (fail-closed): a
 * registry nobody pinned is not one a signer lends authority to. Of an admin with a guardian G
 * (CNRX, CAN-3132) G must sign it too: a factory anchored on another guardian G' is admin-signed
 * and of the same package, and only G's signature tells it apart. A cnrx-registry factory of an
 * admin with no G pinned is refused: without G nothing tells ours from G''s.
 */
export function isRegistryFactory(
  contract: RegistryContract,
  admin: string,
  registries: RegistryPackages = REGISTRY_PACKAGES,
  guardians: RegistryGuardians = REGISTRY_GUARDIANS,
): boolean {
  const packages = Object.hasOwn(registries, admin) ? registries[admin] : undefined;
  if (!packages) return false;
  const guardian = Object.hasOwn(guardians, admin) ? guardians[admin] : undefined;
  if (guardian === undefined ? CNRX_FACTORIES.has(contract.templateId.split(':').slice(1).join(':')) : !contract.signatories.includes(guardian)) return false;
  const packageId = contract.templateId.split(':')[0] ?? '';
  return contract.signatories.includes(admin) || packages.includes(packageId);
}
