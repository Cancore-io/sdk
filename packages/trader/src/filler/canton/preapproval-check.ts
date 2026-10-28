/**
 * The check of `preapproval.create` (protocol §3.19, CAN-2904): before the
 * party key signs, the decoded transaction must create exactly the party's
 * own transfer preapproval with the asked registry — and nothing else.
 *
 * - One transaction, one root, and that root a create: nothing is exercised,
 *   nothing archived, nothing else created, no contract read.
 * - The template is the preapproval of a registry pinned for the asked admin
 *   (`CantonTransferFactory.preapproval`, by package id): a look-alike of
 *   another package is refused.
 * - Its argument: `admin` the asked admin, `receiver` the node's own party
 *   (by its namespace), the stated allowances and window; signed by the party
 *   alone, acting as the party alone.
 * - The window is live: `requestedAt` not ahead of the clock by more than a
 *   minute, `executeBefore` ahead of it.
 *
 * What a preapproval lets in is a credit of the party: a transfer through it
 * moves value only TO the receiver, so signing it risks nothing of the party's.
 *
 * A DA Utilities registry (`preapprovalForm: 'utility'`, CAN-2931): the
 * argument is `operator` (the stated one, which must be the registry's pinned
 * `preapprovalOperator`), `receiver`, `instrumentAdmin` the
 * asked admin and `instrumentAllowances` as `{id}` records; it has no
 * validity window, so the summary states `requestedAt` and `executeBefore`
 * as null.
 *
 * A Splice registry (CC, `preapprovalForm: 'splice'`, CAN-2931): the
 * `TransferPreapproval` is signed by the receiver, its provider and the DSO,
 * so the party signs only the `TransferPreapprovalProposal` — `receiver` the
 * party, `provider` the stated one, which must be the registry's pinned
 * `preapprovalProvider`, `expectedDso` the asked admin. The provider accepts
 * it and pays; the window is the provider's, set on accept, so the summary
 * states `requestedAt` and `executeBefore` as null and no allowance (a Splice
 * preapproval admits every instrument of its DSO, which is only `Amulet`).
 */
import type { CantonOpParams, Hex } from '@cancore/contracts';
import { field, isOwnParty, optionalParty, party, refuse, sameSet, textOf } from './checks';
import { CANTON_TRANSFER_FACTORIES, type CantonTransferFactory } from './factories';
import type { CantonOpCheck, PreparedOf } from './operations';
import type { CantonTransaction, DamlValue } from './transaction';

/** How far ahead of the node's clock a stated `requestedAt` may be: the participant's clock is not the node's. */
const SKEW_MS = 60_000;

const micros = (v: DamlValue): bigint => (v.t === 'timestamp' ? BigInt(v.v) : refuse('expected a Time'));
const seconds = (value: unknown, name: string): bigint => (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : refuse(`${name} is not unix seconds`));

/** `preapproval.create`: exactly the party's own preapproval with a pinned registry of `params.admin`. */
export function checkPreapprovalCreate(expect: {
  params: CantonOpParams['preapproval.create'];
  publicKey: Hex;
  nowMs: number;
  factories?: Readonly<Record<string, readonly CantonTransferFactory[]>>;
}): CantonOpCheck<'preapproval.create'> {
  return (prepared, transactions) => {
    const s = prepared.summary;
    const admin = expect.params.admin;
    if (s.admin !== admin) refuse('the stated admin is not the one asked for');
    if (!isOwnParty(s.party, expect.publicKey)) refuse('the preapproval is for another party than the node key’s');
    if (!Array.isArray(s.instrumentAllowances) || !s.instrumentAllowances.every((a) => typeof a === 'string')) refuse('instrumentAllowances is not a list of instrument ids');

    const registries = ((expect.factories ?? CANTON_TRANSFER_FACTORIES)[admin] ?? []).filter((f) => f.preapproval);
    if (registries.length === 0) refuse(`no pinned registry of ${admin} has a preapproval`);

    if (transactions.length !== 1) refuse(`expected one transaction, got ${transactions.length}`);
    const tx = transactions[0] as CantonTransaction;
    if (tx.roots.length !== 1 || Object.keys(tx.nodes).length !== 1) refuse('the transaction does more than one create');
    if (tx.inputContracts.length !== 0) refuse('the transaction reads contracts a create does not need');
    const root = tx.nodes[tx.roots[0] as string];
    if (root?.kind !== 'create') return refuse('the root is not a create');
    const registry = registries.find((f) => root.templateId === `${f.preapprovalPackageId ?? f.packageId}:${f.preapproval}`);
    if (!registry) return refuse(`${root.templateId} is not the preapproval of a pinned registry of ${admin}`);
    if (!sameSet(tx.actAs, [s.party])) refuse('the transaction acts as another party');
    if (!sameSet(root.signatories, [s.party])) refuse('the preapproval is not signed by the party alone');

    if (registry.preapprovalForm === 'utility') checkUtilityPreapproval(root.argument, s, admin, registry);
    else if (registry.preapprovalForm === 'splice') checkSpliceProposal(root.argument, s, admin, registry);
    else checkCnrxPreapproval(root.argument, s, admin, expect.nowMs);
  };
}

type Stated = PreparedOf<'preapproval.create'>['summary'];

/** CNRX: `admin`, `receiver`, the allowances as ids, and the live window exactly as stated. */
function checkCnrxPreapproval(a: DamlValue, s: Stated, admin: string, nowMs: number): void {
  const requestedAt = seconds(s.requestedAt, 'requestedAt');
  const executeBefore = seconds(s.executeBefore, 'executeBefore');
  if (requestedAt * 1000n > BigInt(nowMs + SKEW_MS)) refuse('requestedAt is ahead of the clock');
  if (executeBefore * 1000n <= BigInt(nowMs)) refuse('executeBefore has passed');
  if (party(field(a, 'admin')) !== admin) refuse('the preapproval is with another admin');
  if (party(field(a, 'receiver')) !== s.party) refuse('the preapproval names another receiver');
  const allowances = field(a, 'instrumentAllowances');
  if (allowances.t !== 'list' || !sameSet(allowances.v.map(textOf), s.instrumentAllowances)) refuse('the allowances are not the stated ones');
  if (micros(field(a, 'requestedAt')) !== requestedAt * 1_000_000n) refuse('requestedAt is not the stated one');
  if (micros(field(a, 'executeBefore')) !== executeBefore * 1_000_000n) refuse('executeBefore is not the stated one');
}

/** DA Utilities: no window; the stated `operator` — the pinned one —, `receiver`, `instrumentAdmin`, and the allowances as `{id}`. */
function checkUtilityPreapproval(a: DamlValue, s: Stated, admin: string, registry: CantonTransferFactory): void {
  if (s.requestedAt !== null || s.executeBefore !== null) refuse('a DA Utilities preapproval has no validity window: requestedAt and executeBefore are stated null');
  if (typeof s.operator !== 'string' || s.operator.length === 0) refuse('the DA Utilities operator is not stated');
  if (!registry.preapprovalOperator) refuse(`the pinned registry of ${admin} pins no DA Utilities operator`);
  if (s.operator !== registry.preapprovalOperator) refuse('the stated operator is not the pinned DA Utilities operator');
  if (party(field(a, 'instrumentAdmin')) !== admin) refuse('the preapproval is with another admin');
  if (party(field(a, 'receiver')) !== s.party) refuse('the preapproval names another receiver');
  if (party(field(a, 'operator')) !== s.operator) refuse('the preapproval names another operator than stated');
  const allowances = field(a, 'instrumentAllowances');
  if (allowances.t !== 'list' || !sameSet(allowances.v.map((v) => textOf(field(v, 'id'))), s.instrumentAllowances)) refuse('the allowances are not the stated ones');
}

/** Splice: the proposal names the party, the stated provider — the pinned one — and the asked admin as the DSO it expects. */
function checkSpliceProposal(a: DamlValue, s: Stated, admin: string, registry: CantonTransferFactory): void {
  if (s.requestedAt !== null || s.executeBefore !== null) refuse('a Splice preapproval’s window is its provider’s: requestedAt and executeBefore are stated null');
  if (s.instrumentAllowances.length !== 0) refuse('a Splice preapproval admits every instrument of its DSO: no allowances are stated');
  if (typeof s.provider !== 'string' || s.provider.length === 0) refuse('the Splice provider is not stated');
  if (!registry.preapprovalProvider) refuse(`the pinned registry of ${admin} pins no Splice provider`);
  if (s.provider !== registry.preapprovalProvider) refuse('the stated provider is not the pinned Splice provider');
  if (party(field(a, 'receiver')) !== s.party) refuse('the proposal names another receiver');
  if (party(field(a, 'provider')) !== s.provider) refuse('the proposal names another provider than stated');
  if (optionalParty(field(a, 'expectedDso')) !== admin) refuse('the proposal expects another DSO than the asked admin');
}
