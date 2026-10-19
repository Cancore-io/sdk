/**
 * The check of `delivery.fill` (protocol §3.19, fillers.md T-32, T-48;
 * CAN-1867): before the party key signs, the decoded transaction must be
 * exactly the delivery of the node's own receipted Canton-form ticket — held to
 * the ticket, the offered order and the node's own identity, never to the
 * backend's summary alone.
 *
 * - One root: `DeliveryOrder_Fill` on the ticket's `deliveryOrderCid`, a
 *   consuming exercise of `cancore-intent`'s `Intent.DeliveryReceipt:DeliveryOrder`,
 *   acting as the node's party alone.
 * - The `DeliveryOrder` as the transaction discloses it (its input contract):
 *   the party is its filler; its `fillerId`, `repayTo`, `orderHash`, `attempt`,
 *   `validUntil` are the node's own and the ticket's; its `recipient`,
 *   instrument and `amount` encode to the offered order's `recipient`,
 *   `outputAsset` and an amount in `[minReceived, amountOut]`; its
 *   `fillDeadline` is the order's. This is where T-48 is enforced on the
 *   ledger's own data: the operator writes `fillerId` and `repayTo` into the
 *   order, and nothing else compares them with the signed `ticket.intent`.
 * - Under the root: `TransferFactory_Transfer` through a pinned factory, from
 *   the party to the recipient, exactly the order's amount and instrument,
 *   spending only the stated holdings, completed in this transaction (a
 *   pending transfer is not a delivery); the fetch of the party's own registry
 *   entry (signed by the operator and the party); and exactly
 *   one `DeliveryReceipt` naming the same filler, fillerId, repayTo, order,
 *   attempt, recipient, instrument and amount. Nothing else.
 * - `validUntil` has not passed by the process clock.
 */
import { encodeCantonAmount, encodeCantonOutputAsset, encodeCantonRecipient, type Hex } from '@cancore/contracts';
import { canonicalDecimal, checkTransferExercise, field, isOwnParty, numeric, party, qualified, refuse, sameSet, soleRoot, subtree, textOf, cids } from './checks';
import { CANTON_TRANSFER_FACTORIES, type CantonTransferFactory } from './factories';
import type { CantonOpCheck } from './operations';
import type { DamlValue, ExerciseNode } from './transaction';

/** The Daml package the delivery templates come from (`canton-contracts` `intent/daml.yaml`). */
export const INTENT_PACKAGE_NAME = 'cancore-intent';
const ORDER = 'Intent.DeliveryReceipt:DeliveryOrder';
const RECEIPT = 'Intent.DeliveryReceipt:DeliveryReceipt';
const REGISTRY_ENTRY = 'Intent.FillerRegistry:FillerRegistryEntry';

/** What the node itself knows of the delivery it is bound to: its ticket, the offered order, its identity. */
export interface DeliveryFillExpectation {
  /** The node's party key, 32 bytes hex: the party must be in its namespace. */
  publicKey: Hex;
  fillerId: string;
  orderHash: Hex;
  attempt: number;
  /** `ticket.issued.deliveryOrderCid`, exactly as received. */
  deliveryOrderCid: string;
  /** `ticket.issued.validUntil`, unix seconds. */
  validUntil: string;
  /** The `repayTo` of the node's own `ticket.intent`. */
  repayTo: Hex;
  /** The offered order's `recipient`, `outputAsset`, `minReceived`, `fillDeadline` (unix s). */
  order: { recipient: Hex; outputAsset: Hex; minReceived: string; fillDeadline: string };
  /** The filler's own quote, `ticket.offer.amountOut`, Numeric 10 × 10¹⁰: never delivered more than this. */
  amountOut: string;
  nowMs: number;
  /** The pinned factories; `CANTON_TRANSFER_FACTORIES` unless a test names others. */
  factories?: Readonly<Record<string, readonly CantonTransferFactory[]>>;
}

const lowerHex = (value: string): string => (value.startsWith('0x') ? value.slice(2) : value).toLowerCase();
/** A `Bytes32`/`BytesHex` of `Intent.Canonical`: a record `{hex}` of lowercase hex without `0x`. */
const bytes32 = (v: DamlValue): string => {
  const hex = textOf(field(v, 'hex'));
  if (!/^[0-9a-f]{64}$/.test(hex)) refuse('a Bytes32 that is not 32 bytes of lowercase hex');
  return hex;
};
const int = (v: DamlValue): bigint => (v.t === 'int64' ? BigInt(v.v) : refuse('expected an Int'));
const micros = (v: DamlValue): bigint => (v.t === 'timestamp' ? BigInt(v.v) : refuse('expected a Time'));
const seconds = (value: string, name: string): bigint => (/^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : refuse(`${name} is not unix seconds`));
const units = (amount: string): bigint => {
  try {
    return encodeCantonAmount(canonicalDecimal(amount));
  } catch {
    return refuse(`amount ${amount} is not exact at 10⁻¹⁰`);
  }
};
const instrumentOf = (v: DamlValue): { admin: string; id: string } => ({ admin: party(field(v, 'admin')), id: textOf(field(v, 'id')) });

/** `delivery.fill`: exactly the delivery of the node's own ticket, from its own party, nothing else. */
export function checkDeliveryFill(expect: DeliveryFillExpectation): CantonOpCheck<'delivery.fill'> {
  return (prepared, transactions) => {
    const s = prepared.summary;
    const orderHash = lowerHex(expect.orderHash);
    const repayTo = lowerHex(expect.repayTo);
    const validUntil = seconds(expect.validUntil, 'validUntil');
    const fillDeadline = seconds(expect.order.fillDeadline, 'fillDeadline');

    // -- The summary repeats the ticket (a cheap first look; the transaction decides) --
    if (lowerHex(String(s.orderHash)) !== orderHash || s.attempt !== expect.attempt) refuse('the stated order or attempt is not the ticket’s');
    if (s.deliveryOrderCid !== expect.deliveryOrderCid) refuse('the stated DeliveryOrder is not the ticket’s');
    if (lowerHex(String(s.repayTo)) !== repayTo) refuse('the stated repayTo is not the one of the node’s ticket.intent');
    if (String(s.validUntil) !== expect.validUntil) refuse('the stated validUntil is not the ticket’s');
    if (String(s.executeBefore) !== expect.order.fillDeadline) refuse('the stated executeBefore is not the order’s fillDeadline');
    if (validUntil * 1000n < BigInt(expect.nowMs)) refuse('the ticket has expired');
    if (encodeCantonRecipient(s.recipient) !== expect.order.recipient.toLowerCase()) refuse('the stated recipient is not the order’s');
    if (encodeCantonOutputAsset(s.asset) !== expect.order.outputAsset.toLowerCase()) refuse('the stated instrument is not the order’s outputAsset');
    const amount = units(s.amount);
    if (amount < BigInt(expect.order.minReceived)) refuse(`the stated amount ${s.amount} is below the order’s minReceived`);
    if (amount > BigInt(expect.amountOut)) refuse(`the stated amount ${s.amount} is above the filler’s own quote`);

    // -- The root: DeliveryOrder_Fill on the ticket's order, as the party alone --
    const { tx, root } = soleRoot(transactions);
    const filler = root.actingParties[0];
    if (root.actingParties.length !== 1 || !isOwnParty(filler, expect.publicKey)) refuse('the fill acts as another party than the node key’s');
    const me = filler as string;
    if (!sameSet(tx.actAs, [me])) refuse('the transaction acts as another party');
    if (root.packageName !== INTENT_PACKAGE_NAME || qualified(root.templateId) !== ORDER || root.choice !== 'DeliveryOrder_Fill' || !root.consuming) {
      refuse(`the root is ${root.packageName} ${qualified(root.templateId)}.${root.choice}, not DeliveryOrder_Fill`);
    }
    if (root.contractId !== expect.deliveryOrderCid) refuse('the fill is on another contract than the ticket’s DeliveryOrder');
    if (!sameSet(cids(field(root.chosenValue, 'inputHoldingCids')), s.inputHoldingCids)) refuse('the fill spends other holdings than stated');

    // -- The DeliveryOrder as the transaction discloses it: the ledger's own terms --
    const order = tx.inputContracts.find((c) => c.contractId === expect.deliveryOrderCid);
    if (!order) return refuse('the DeliveryOrder is not disclosed with the transaction');
    if (order.templateId !== root.templateId || order.packageName !== INTENT_PACKAGE_NAME) refuse('the disclosed DeliveryOrder is of another template');
    const o = order.argument;
    if (party(field(o, 'filler')) !== me) refuse('the DeliveryOrder names another filler party');
    if (textOf(field(o, 'fillerId')) !== expect.fillerId) refuse('the DeliveryOrder names another fillerId');
    if (bytes32(field(o, 'repayTo')) !== repayTo) refuse('the DeliveryOrder names another repayTo than the node’s ticket.intent (T-48)');
    if (bytes32(field(o, 'orderHash')) !== orderHash) refuse('the DeliveryOrder is for another order');
    if (int(field(o, 'attempt')) !== BigInt(expect.attempt)) refuse('the DeliveryOrder is for another attempt');
    if (micros(field(o, 'validUntil')) !== validUntil * 1_000_000n) refuse('the DeliveryOrder has another validUntil than the ticket');
    if (micros(field(o, 'fillDeadline')) !== fillDeadline * 1_000_000n) refuse('the DeliveryOrder has another fillDeadline than the order');
    const recipient = party(field(o, 'recipient'));
    if (recipient !== s.recipient) refuse('the DeliveryOrder has another recipient than stated');
    const instrument = instrumentOf(field(o, 'instrumentId'));
    if (instrument.admin !== s.asset.admin || instrument.id !== s.asset.id) refuse('the DeliveryOrder has another instrument than stated');
    if (party(field(o, 'instrumentAdmin')) !== instrument.admin) refuse('the DeliveryOrder pins another instrument admin');
    const factoryCid = field(o, 'transferFactoryCid');
    if (factoryCid.t !== 'contractId' || factoryCid.v !== s.transferFactoryCid) refuse('the DeliveryOrder pins another transfer factory than stated');
    if (numeric(field(o, 'amount')) !== canonicalDecimal(s.amount)) refuse('the DeliveryOrder delivers another amount than stated');
    const operator = party(field(o, 'operator'));

    // -- Under the root: the transfer, the registry fetch, the receipt; nothing else --
    if (subtree(tx, root.nodeId).length !== Object.keys(tx.nodes).length) refuse('the transaction holds nodes outside the fill');
    let transfer: ExerciseNode | undefined;
    let receipts = 0;
    for (const id of root.children) {
      const node = tx.nodes[id];
      if (node?.kind === 'exercise' && node.choice === 'TransferFactory_Transfer' && !transfer) {
        if (node.contractId !== s.transferFactoryCid) refuse('the transfer goes through another factory than the order pins');
        transfer = node;
      } else if (node?.kind === 'fetch' && qualified(node.templateId) === REGISTRY_ENTRY && node.packageName === INTENT_PACKAGE_NAME) {
        // assertRegisteredFiller: a read of the party's own registry entry, co-signed by the operator and the party.
        if (!sameSet(node.signatories, [operator, me])) refuse('the fill reads a registry entry that is not the party’s own');
      } else if (node?.kind === 'create' && qualified(node.templateId) === RECEIPT && node.packageName === INTENT_PACKAGE_NAME) {
        receipts += 1;
        checkReceipt(node.argument, node.signatories, { me, operator, fillerId: expect.fillerId, repayTo, orderHash, attempt: expect.attempt, recipient, instrument, amount: s.amount });
      } else {
        refuse(`the fill does ${node ? `${node.kind} ${node.kind === 'rollback' ? '' : qualified(node.templateId)}` : 'a node not in the transaction'} besides the delivery`);
      }
    }
    if (!transfer) return refuse('the fill moves nothing: no TransferFactory_Transfer');
    if (receipts !== 1) refuse(`the fill creates ${receipts} DeliveryReceipts, not one`);
    checkTransferExercise(tx, transfer, {
      sender: me,
      asked: { asset: s.asset, amount: s.amount, toParty: recipient },
      stated: s.inputHoldingCids,
      executeBefore: expect.order.fillDeadline,
      factories: expect.factories ?? CANTON_TRANSFER_FACTORIES,
      completedOnly: true,
    });
  };
}

function checkReceipt(
  r: DamlValue,
  signatories: readonly string[],
  e: { me: string; operator: string; fillerId: string; repayTo: string; orderHash: string; attempt: number; recipient: string; instrument: { admin: string; id: string }; amount: string },
): void {
  if (!sameSet(signatories, [e.operator, e.me])) refuse('the DeliveryReceipt is not signed by exactly the operator and the party');
  if (party(field(r, 'operator')) !== e.operator || party(field(r, 'filler')) !== e.me) refuse('the DeliveryReceipt names another operator or filler');
  if (textOf(field(r, 'fillerId')) !== e.fillerId) refuse('the DeliveryReceipt names another fillerId');
  if (bytes32(field(r, 'repayTo')) !== e.repayTo) refuse('the DeliveryReceipt names another repayTo');
  if (bytes32(field(r, 'orderHash')) !== e.orderHash || int(field(r, 'attempt')) !== BigInt(e.attempt)) refuse('the DeliveryReceipt is for another order or attempt');
  if (party(field(r, 'recipient')) !== e.recipient) refuse('the DeliveryReceipt names another recipient');
  const instrument = instrumentOf(field(r, 'instrumentId'));
  if (instrument.admin !== e.instrument.admin || instrument.id !== e.instrument.id) refuse('the DeliveryReceipt names another instrument');
  if (numeric(field(r, 'amount')) !== canonicalDecimal(e.amount)) refuse('the DeliveryReceipt records another amount');
}

