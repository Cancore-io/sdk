/**
 * `intent.settle` (protocol §3.19, fillers.md T-35, T-36; CAN-2321): the
 * filler party's `SwapIntent_SettleWithProof` on the Canton-source intent it
 * delivered for, prepared by Cancore with the attestor signatures
 * filler-gateway holds. The node signs it only when the decoded transaction is
 * exactly the payout of its own delivery:
 *
 * - one root, `SwapIntent_SettleWithProof` on the intent of this orderHash (of
 *   the template the node read), acting as the party alone, consuming it;
 * - the proof in the choice is the node's own (`expected`): its fill, its
 *   `fillerId`, `repayTo` = `keccak256(utf8(party))`, its attempt and set;
 *   `fillerEntryCid` is the party's own ACTIVE registry entry;
 * - nothing the party already signed is consumed: the settlement spends none
 *   of its holdings;
 * - one `SettlementFactory_SettleBatch` of a pinned registry, on the
 *   settlement factory the choice names (CAN-3172: the registry's current one,
 *   not the one pinned at Open), whose transfer
 *   legs are exactly `payout` from the owner to the party and, when there is a
 *   fee, `fee` from the owner to the operator, split as the ledger splits;
 * - the party is credited exactly the payout in unlocked holdings of the
 *   instrument.
 *
 * The summary states the same economics; it is checked, never trusted alone.
 */
import { cantonInclusiveFeeSplit, type CantonIntent, type FillProofJson, type Hex } from '@cancore/contracts';
import { CANTON_TRANSFER_FACTORIES, type CantonTransferFactory } from './factories';
import { canonicalDecimal, decimal, field, holdingOf, isOwnParty, optionalParty, qualified, refuse, requireNamedFactory, sameSet, scaled, soleRoot, subtree, textOf } from './checks';
import type { CantonOpCheck } from './operations';
import type { DamlValue, ExerciseNode } from './transaction';

const SWAP_INTENT = 'Intent.SwapIntent:SwapIntent';
const SETTLE_WITH_PROOF = 'SwapIntent_SettleWithProof';
const SETTLE_BATCH = 'SettlementFactory_SettleBatch';

export interface IntentSettleExpectation {
  /** The party's Ed25519 public key: the party is in its namespace. */
  publicKey: Hex;
  /** The node's own Canton party: the payee. */
  party: string;
  /** The intent the node delivered for, as read before signing. */
  intent: CantonIntent;
  /** The order's `feeBps`, from the EVM-form order the intent's terms build. */
  feeBps: bigint;
  /** The proof of the node's own delivery: what the attestors had to sign. */
  proof: FillProofJson;
  /** The party's ACTIVE `FillerRegistryEntry`. */
  entryCid: string;
  /** The pinned registries; `CANTON_TRANSFER_FACTORIES` unless a test names others. */
  factories?: Readonly<Record<string, readonly CantonTransferFactory[]>>;
}

/** The split of the give the ledger makes: `payout` to the filler, `fee` to the operator (`SwapIntent.daml` legsOf). */
export function intentSplit(intent: CantonIntent, feeBps: bigint): { payout: bigint; fee: bigint } {
  return cantonInclusiveFeeSplit(scaled(intent.amount), feeBps);
}

const lower = (v: unknown): string => String(v).toLowerCase();
const bytes32 = (v: DamlValue): string => `0x${textOf(field(v, 'hex')).replace(/^0x/, '')}`.toLowerCase();
const int = (v: DamlValue): string => (v.t === 'int64' ? v.v : refuse('expected an Int'));
const uint256 = (v: DamlValue): bigint => BigInt(`0x${textOf(field(v, 'hex')).replace(/^0x/, '') || '0'}`);

/** The `FillProof` of the choice against the node's own; the first field that differs is refused. */
function checkProof(chosen: DamlValue, own: FillProofJson): void {
  const p = field(chosen, 'proof');
  const words = ['orderHash', 'destination', 'fillRef', 'recipient', 'outputAsset', 'fillerId', 'repayTo'] as const;
  for (const w of words) if (bytes32(field(p, w)) !== lower(own[w])) refuse(`proof.${w} is not the node's own`);
  if (int(field(p, 'kind')) !== String(own.kind)) refuse('proof.kind is not the node’s own');
  if (uint256(field(p, 'amountDelivered')) !== BigInt(own.amountDelivered)) refuse('proof.amountDelivered is not the node’s own delivery');
  if (int(field(p, 'filledAt')) !== String(own.filledAt)) refuse('proof.filledAt is not the node’s own delivery');
  if (int(field(p, 'attempt')) !== String(own.attempt)) refuse('proof.attempt is not the node’s own');
  if (int(field(p, 'setId')) !== String(own.setId)) refuse('proof.setId is not the set of the attestations');
}

/** `intent.settle`: exactly the payout of the node's own delivery, to its own party. */
export function checkIntentSettle(expect: IntentSettleExpectation): CantonOpCheck<'intent.settle'> {
  return (prepared, transactions) => {
    const { intent, party: payee } = expect;
    const s = prepared.summary;
    const { payout, fee } = intentSplit(intent, expect.feeBps);
    if (!isOwnParty(payee, expect.publicKey)) refuse('the payee is not in the node key’s namespace');
    if (lower(s.orderHash) !== lower(intent.orderHash)) refuse('the summary is for another order');
    if (s.intentCid !== intent.intentCid) refuse('the summary names another intent');
    if (s.payee !== payee) refuse('the stated payee is not the node’s party');
    if (s.asset.admin !== intent.asset.admin || s.asset.id !== intent.asset.id) refuse('the stated instrument is not the intent’s');
    if (canonicalDecimal(s.giveAmount) !== canonicalDecimal(intent.amount)) refuse('the stated give is not the intent’s');
    if (scaled(s.amount) !== payout) refuse(`the stated payout ${s.amount} is not ${decimal(payout)}`);
    if (s.fee.receiver !== intent.operator || scaled(s.fee.amount) !== fee) refuse('the stated fee leg is not the operator’s split');
    if (s.executeBefore !== intent.refundAfter) refuse('executeBefore is not refundAfter');

    const { tx, root } = soleRoot(transactions);
    if (!sameSet(tx.actAs, [payee])) refuse('the transaction acts as another party');
    if (root.templateId !== intent.templateId || qualified(root.templateId) !== SWAP_INTENT || root.choice !== SETTLE_WITH_PROOF) {
      refuse(`the root is ${qualified(root.templateId)}.${root.choice}, not ${SETTLE_WITH_PROOF} of the intent`);
    }
    if (root.contractId !== intent.intentCid) refuse('the settle is on another contract than the intent');
    if (!root.consuming || !sameSet(root.actingParties, [payee])) refuse('the settle does not consume the intent as the party alone');
    checkProof(root.chosenValue, expect.proof);
    const entry = field(root.chosenValue, 'fillerEntryCid');
    if (entry.t !== 'contractId' || entry.v !== expect.entryCid) refuse('the settle names another registry entry than the party’s');

    const nodes = subtree(tx, root.nodeId);
    if (nodes.length !== Object.keys(tx.nodes).length) refuse('the transaction holds nodes outside the settle');
    const created = new Set(nodes.flatMap((n) => (n.kind === 'create' ? [n.contractId] : [])));
    for (const n of nodes) {
      if (n.kind === 'rollback') refuse('a rollback node inside the settle');
      // The party's own contracts stay its own: only what this transaction creates for it may be consumed.
      if (n.kind === 'exercise' && n.consuming && n !== root && !created.has(n.contractId) && n.signatories.includes(payee)) {
        refuse(`the settle consumes ${qualified(n.templateId)} ${n.contractId} of the party`);
      }
    }

    const factories = (expect.factories ?? CANTON_TRANSFER_FACTORIES)[intent.asset.admin] ?? [];
    const batches = nodes.filter((n): n is ExerciseNode => n.kind === 'exercise' && n.choice === SETTLE_BATCH);
    if (batches.length !== 1) refuse(`expected one ${SETTLE_BATCH}, got ${batches.length}`);
    const batch = batches[0] as ExerciseNode;
    const registry = factories.find((f) => batch.templateId.startsWith(`${f.packageId}:`));
    if (!registry) return refuse(`the settlement factory ${batch.templateId} is not of a pinned registry of ${intent.asset.admin}`);
    requireNamedFactory(root.chosenValue, 'settlementFactory', batch.contractId, 'the batch runs another settlement factory than the settle names');
    checkLegs(field(batch.chosenValue, 'transferLegs'), intent, payee, payout, fee);

    // What the party ends up with: unlocked holdings of the instrument, exactly the payout.
    let credited = 0n;
    for (const n of nodes) {
      if (n.kind !== 'create' || n.templateId !== `${registry.packageId}:${registry.holding}`) continue;
      const h = holdingOf(n.argument, registry);
      if (h.owner !== payee) continue;
      if (h.admin !== intent.asset.admin || h.id !== intent.asset.id || h.locked) refuse('the party is credited a locked holding or another instrument');
      credited += h.amount;
    }
    if (credited !== payout) refuse(`the party is credited ${decimal(credited)}, not ${decimal(payout)}`);
  };
}

/** The batch's transfer legs: exactly `payout` owner → party and `fee` owner → operator (when non-zero). */
function checkLegs(legs: DamlValue, intent: CantonIntent, payee: string, payout: bigint, fee: bigint): void {
  if (legs.t !== 'list') return refuse('transferLegs is not a list');
  const want = [{ id: 'payout', receiver: payee, amount: payout }, ...(fee > 0n ? [{ id: 'fee', receiver: intent.operator, amount: fee }] : [])];
  if (legs.v.length !== want.length) refuse(`the batch moves ${legs.v.length} legs, not ${want.length}`);
  for (const w of want) {
    const leg = legs.v.find((l) => textOf(field(l, 'transferLegId')) === w.id);
    if (!leg) return refuse(`the batch has no ${w.id} leg`);
    if (optionalParty(field(field(leg, 'sender'), 'owner')) !== intent.owner) refuse(`the ${w.id} leg is not from the owner`);
    if (optionalParty(field(field(leg, 'receiver'), 'owner')) !== w.receiver) refuse(`the ${w.id} leg pays another party`);
    if (textOf(field(leg, 'instrumentId')) !== intent.asset.id) refuse(`the ${w.id} leg moves another instrument`);
    const amount = field(leg, 'amount');
    if (amount.t !== 'numeric' || scaled(amount.v) !== w.amount) refuse(`the ${w.id} leg moves another amount than ${decimal(w.amount)}`);
  }
}
