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
 */
import type { CantonOpParams, Hex } from '@cancore/contracts';
import { field, isOwnParty, party, refuse, sameSet, textOf } from './checks';
import { CANTON_TRANSFER_FACTORIES, type CantonTransferFactory } from './factories';
import type { CantonOpCheck } from './operations';
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
    const requestedAt = seconds(s.requestedAt, 'requestedAt');
    const executeBefore = seconds(s.executeBefore, 'executeBefore');
    if (requestedAt * 1000n > BigInt(expect.nowMs + SKEW_MS)) refuse('requestedAt is ahead of the clock');
    if (executeBefore * 1000n <= BigInt(expect.nowMs)) refuse('executeBefore has passed');
    if (!Array.isArray(s.instrumentAllowances) || !s.instrumentAllowances.every((a) => typeof a === 'string')) refuse('instrumentAllowances is not a list of instrument ids');

    const registries = (expect.factories ?? CANTON_TRANSFER_FACTORIES)[admin] ?? [];
    const templates = registries.flatMap((f) => (f.preapproval ? [`${f.packageId}:${f.preapproval}`] : []));
    if (templates.length === 0) refuse(`no pinned registry of ${admin} has a preapproval`);

    if (transactions.length !== 1) refuse(`expected one transaction, got ${transactions.length}`);
    const tx = transactions[0] as CantonTransaction;
    if (tx.roots.length !== 1 || Object.keys(tx.nodes).length !== 1) refuse('the transaction does more than one create');
    if (tx.inputContracts.length !== 0) refuse('the transaction reads contracts a create does not need');
    const root = tx.nodes[tx.roots[0] as string];
    if (root?.kind !== 'create') return refuse('the root is not a create');
    if (!templates.includes(root.templateId)) refuse(`${root.templateId} is not the preapproval of a pinned registry of ${admin}`);
    if (!sameSet(tx.actAs, [s.party])) refuse('the transaction acts as another party');
    if (!sameSet(root.signatories, [s.party])) refuse('the preapproval is not signed by the party alone');

    const a = root.argument;
    if (party(field(a, 'admin')) !== admin) refuse('the preapproval is with another admin');
    if (party(field(a, 'receiver')) !== s.party) refuse('the preapproval names another receiver');
    const allowances = field(a, 'instrumentAllowances');
    if (allowances.t !== 'list' || !sameSet(allowances.v.map(textOf), s.instrumentAllowances)) refuse('the allowances are not the stated ones');
    if (micros(field(a, 'requestedAt')) !== requestedAt * 1_000_000n) refuse('requestedAt is not the stated one');
    if (micros(field(a, 'executeBefore')) !== executeBefore * 1_000_000n) refuse('executeBefore is not the stated one');
  };
}
