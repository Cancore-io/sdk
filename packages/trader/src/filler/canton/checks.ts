/**
 * The economic checks of the filler party's own operations (protocol §3.19):
 * what each decoded transaction must do, held to what the node itself asked
 * for — never to the summary alone. A check throws `CantonRefusal`; then
 * nothing is signed. The party is recognised by its namespace: the
 * fingerprint of the node's own key.
 *
 * - `registry.accept`: one root, `FillerRegistryEntryProposal_Accept` on the
 *   proposal, acting as the party alone, creating exactly the
 *   `FillerRegistryEntry` of this fillerId and party with the stated operator.
 * - `holdings.transfer`: one root, `TransferFactory_Transfer` through the
 *   token standard's TransferFactory, acting as the party alone, with the
 *   asked receiver, amount, instrument and holdings — and, under it, what the
 *   factory does: the factory is a pinned one (`factories.ts`); the only
 *   exercises on the sender's contracts archive the stated inputs (or are a
 *   pinned service choice); every holding created is of the asked instrument
 *   and owned by the sender or the receiver; the receiver is credited exactly
 *   the amount (direct) or the amount is locked to the sender under one offer
 *   of exactly this transfer (pending); the change is at most the inputs minus
 *   the amount.
 *
 * `delivery.fill` checks against the node’s ticket and order (CAN-1867,
 * `delivery-check.ts`); `intent.settle` against the intent (CAN-2321).
 */
import type { CantonOpParams, Hex } from '@cancore/contracts';
import { CANTON_TRANSFER_FACTORIES, type CantonTransferFactory } from './factories';
import { CantonRefusal, cantonFingerprint } from './legs';
import type { CantonOpCheck } from './operations';
import type { CantonTransaction, DamlValue, ExerciseNode, TransactionNode } from './transaction';

const REGISTRY_MODULE = 'Intent.FillerRegistry';
const TRANSFER_FACTORY = 'Splice.Api.Token.TransferInstructionV1:TransferFactory';

export const refuse = (detail: string): never => {
  throw new CantonRefusal('-', detail);
};

/** `<module>:<entity>` of a `<package id>:<module>:<entity>` id. */
export const qualified = (templateId: string | undefined): string => (templateId ?? '').split(':').slice(1).join(':');

/** Whether `party` is in the namespace of the node key: `<hint>::fingerprint(key)`, nothing after it. */
export function isOwnParty(party: unknown, publicKey: Hex): boolean {
  if (typeof party !== 'string') return false;
  const parts = party.split('::');
  return parts.length === 2 && (parts[0] ?? '').length > 0 && parts[1] === cantonFingerprint(publicKey);
}

/** A Daml Decimal as a canonical string: `1.50` and `1.5000000000` are the same amount. */
export function canonicalDecimal(value: string): string {
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) refuse(`not a decimal: ${value}`);
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function field(value: DamlValue | undefined, name: string): DamlValue {
  if (value?.t !== 'record' || !(name in value.v)) return refuse(`no field ${name}`);
  return value.v[name] as DamlValue;
}
export const party = (v: DamlValue): string => (v.t === 'party' ? v.v : refuse('expected a party'));
export const textOf = (v: DamlValue): string => (v.t === 'text' ? v.v : refuse('expected text'));
export const numeric = (v: DamlValue): string => (v.t === 'numeric' ? canonicalDecimal(v.v) : refuse('expected a decimal'));
const FACTORY_PIN = 'Intent.RegistryFactoryPin:RegistryFactoryPin';
const someCid = (value: DamlValue | undefined): string | undefined => (value?.t === 'optional' && value.v?.t === 'contractId' ? value.v.v : undefined);

/**
 * The choice's trailing `factoryPin` (CAN-3172): the operator's `RegistryFactoryPin`, disclosed with the transaction,
 * whose `role` factory is `cid` — the factory the transaction runs. A command without it (0.4.2) or naming None is refused.
 */
export function requirePinnedFactory(tx: CantonTransaction, chosen: DamlValue, operator: string, role: string, cid: string, what: string): void {
  const pinCid = someCid(chosen.t === 'record' ? chosen.v.factoryPin : undefined);
  if (!pinCid) return refuse('the choice names no registry factory pin');
  const pin = tx.inputContracts.find((c) => c.contractId === pinCid);
  if (!pin || pin.packageName !== 'cancore-intent' || qualified(pin.templateId) !== FACTORY_PIN) return refuse('the registry factory pin is not disclosed with the transaction');
  if (party(field(pin.argument, 'operator')) !== operator) refuse('the registry factory pin is not the operator’s');
  if (someCid(pin.argument.t === 'record' ? pin.argument.v[role] : undefined) !== cid) refuse(what);
}

export const optionalParty = (v: DamlValue | undefined): string | undefined => (v?.t === 'optional' ? (v.v ? party(v.v) : undefined) : v ? party(v) : undefined);
export const cids = (v: DamlValue): string[] => (v.t === 'list' ? v.v.map((x) => (x.t === 'contractId' ? x.v : refuse('expected a contract id'))) : refuse('expected a list'));

/** The one transaction of the op and its one root, an exercise. */
export function soleRoot(transactions: readonly CantonTransaction[]): { tx: CantonTransaction; root: ExerciseNode } {
  if (transactions.length !== 1) refuse(`expected one transaction, got ${transactions.length}`);
  const tx = transactions[0] as CantonTransaction;
  if (tx.roots.length !== 1) refuse(`expected one root, got ${tx.roots.length}`);
  const root = tx.nodes[tx.roots[0] as string];
  if (root?.kind !== 'exercise') return refuse('the root is not an exercise');
  return { tx, root };
}

/** Every node under `root`, root included; a node id missing from the transaction is refused. */
export function subtree(tx: CantonTransaction, rootId: string): TransactionNode[] {
  const out: TransactionNode[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = tx.nodes[id];
    if (!node) return refuse(`node ${id} is not in the transaction`);
    out.push(node);
    if (node.kind === 'exercise' || node.kind === 'rollback') stack.push(...node.children);
  }
  return out;
}

export const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** `registry.accept`: the party accepts exactly its own registry entry for `fillerId`. */
export function checkRegistryAccept(expect: { fillerId: string; publicKey: Hex }): CantonOpCheck<'registry.accept'> {
  return (prepared, transactions) => {
    const s = prepared.summary;
    if (s.fillerId !== expect.fillerId) refuse(`the entry is for fillerId ${String(s.fillerId)}`);
    if (!isOwnParty(s.party, expect.publicKey)) refuse('the entry is for another party than the node key’s');
    const { tx, root } = soleRoot(transactions);
    if (!sameSet(tx.actAs, [s.party])) refuse('the transaction acts as another party');
    if (qualified(root.templateId) !== `${REGISTRY_MODULE}:FillerRegistryEntryProposal` || root.choice !== 'FillerRegistryEntryProposal_Accept') {
      refuse(`the root is ${qualified(root.templateId)}.${root.choice}, not the proposal's accept`);
    }
    if (root.contractId !== s.proposalCid) refuse('the accept is on another contract than the stated proposal');
    if (!sameSet(root.actingParties, [s.party])) refuse('the accept acts as another party');
    const nodes = subtree(tx, root.nodeId);
    if (nodes.length !== Object.keys(tx.nodes).length) refuse('the transaction holds nodes outside the accept');
    const creates = nodes.filter((n) => n.kind === 'create');
    if (creates.length !== 1 || nodes.length !== 2) refuse('the accept must create exactly the entry and nothing else');
    const entry = creates[0];
    if (entry?.kind !== 'create' || qualified(entry.templateId) !== `${REGISTRY_MODULE}:FillerRegistryEntry`) return refuse('the accept creates something else than a FillerRegistryEntry');
    if (party(field(entry.argument, 'operator')) !== s.operator) refuse('the entry names another operator');
    if (textOf(field(entry.argument, 'fillerId')) !== expect.fillerId) refuse('the entry names another fillerId');
    if (party(field(entry.argument, 'filler')) !== s.party) refuse('the entry names another filler party');
    if (!sameSet(entry.signatories, [s.operator, s.party])) refuse('the entry is not signed by exactly the operator and the party');
  };
}

/** `holdings.transfer`: exactly the transfer the node asked for, from its own party, spending only the stated holdings. */
export function checkHoldingsTransfer(expect: {
  params: CantonOpParams['holdings.transfer'];
  publicKey: Hex;
  nowMs: number;
  /** The pinned factories; `CANTON_TRANSFER_FACTORIES` unless a test names others. */
  factories?: Readonly<Record<string, readonly CantonTransferFactory[]>>;
}): CantonOpCheck<'holdings.transfer'> {
  return (prepared, transactions) => {
    const s = prepared.summary;
    const asked = expect.params;
    if (s.receiver !== asked.toParty) refuse('the stated receiver is not the one asked for');
    if (s.asset.admin !== asked.asset.admin || s.asset.id !== asked.asset.id) refuse('the stated instrument is not the one asked for');
    if (canonicalDecimal(s.amount) !== canonicalDecimal(asked.amount)) refuse('the stated amount is not the one asked for');
    const { tx, root } = soleRoot(transactions);
    const [sender, ...others] = root.actingParties;
    if (others.length > 0 || !isOwnParty(sender, expect.publicKey)) refuse('the transfer acts as another party than the node key’s');
    if (!sameSet(tx.actAs, [sender as string])) refuse('the transaction acts as another party');
    if (sender === asked.toParty) refuse('a transfer to the party itself');
    if (BigInt(s.executeBefore) * 1000n <= BigInt(expect.nowMs)) refuse('executeBefore has passed');
    if (subtree(tx, root.nodeId).length !== Object.keys(tx.nodes).length) refuse('the transaction holds nodes outside the transfer');
    checkTransferExercise(tx, root, {
      sender: sender as string,
      asked,
      stated: s.inputHoldingCids,
      executeBefore: s.executeBefore,
      factories: expect.factories ?? CANTON_TRANSFER_FACTORIES,
    });
  };
}

/** Daml Decimal (scale 10) as an integer count of 10⁻¹⁰. */
export function scaled(value: string): bigint {
  const [whole, fraction = ''] = canonicalDecimal(value).split('.') as [string, string?];
  if (fraction.length > 10) refuse(`more than 10 decimals: ${value}`);
  const sign = whole.startsWith('-') ? -1n : 1n;
  return sign * (BigInt(whole.replace('-', '')) * 10n ** 10n + BigInt(fraction.padEnd(10, '0')));
}
export const decimal = (units: bigint): string => {
  const abs = units < 0n ? -units : units;
  const fraction = (abs % 10n ** 10n).toString().padStart(10, '0').replace(/0+$/, '');
  return `${units < 0n ? '-' : ''}${abs / 10n ** 10n}${fraction ? `.${fraction}` : ''}`;
};

/** A holding as the token standard's view reads it. */
export interface HoldingSeen {
  owner: string | undefined;
  admin: string;
  id: string;
  amount: bigint;
  locked: boolean;
}
export function holdingOf(argument: DamlValue, f: CantonTransferFactory): HoldingSeen {
  const view = field(argument, f.holdingView);
  const account = field(view, 'account');
  const instrument = field(view, 'instrumentId');
  const lock = view.t === 'record' ? view.v.lock : undefined;
  return {
    owner: optionalParty(field(account, 'owner')),
    admin: party(field(instrument, 'admin')),
    id: textOf(field(instrument, 'id')),
    amount: scaled(numeric(field(view, 'amount'))),
    locked: lock !== undefined && !(lock.t === 'optional' && lock.v === undefined),
  };
}
/** The owner of a token-standard account (V2), or a party (V1). */
const accountOwner = (v: DamlValue): string | undefined => (v.t === 'record' ? optionalParty(v.v.owner) : party(v));

/** What a `TransferFactory_Transfer` exercise must be: exactly the asked transfer from `sender`. */
export interface TransferExpectation {
  sender: string;
  asked: CantonOpParams['holdings.transfer'];
  /** The holdings stated to be spent. */
  stated: readonly string[];
  /** The transfer's `executeBefore`, unix seconds. */
  executeBefore: string;
  factories: Readonly<Record<string, readonly CantonTransferFactory[]>>;
  /** Refuse a pending transfer: the receiver must be credited in this transaction (`delivery.fill`). */
  completedOnly?: boolean;
}

/**
 * `TransferFactory_Transfer` on `node`, acting as the sender alone, with the
 * asked receiver, amount, instrument, holdings and `executeBefore` — and what
 * the factory does under it (`checkTransferSubtree`).
 */
export function checkTransferExercise(tx: CantonTransaction, node: ExerciseNode, o: TransferExpectation): void {
  const { sender, asked } = o;
  if (!sameSet(node.actingParties, [sender])) refuse('the transfer acts as another party than the sender');
  if (qualified(node.interfaceId) !== TRANSFER_FACTORY || node.choice !== 'TransferFactory_Transfer') refuse('the transfer is not TransferFactory_Transfer');
  if (party(field(node.chosenValue, 'expectedAdmin')) !== asked.asset.admin) refuse('the factory is for another instrument admin');
  const transfer = field(node.chosenValue, 'transfer');
  if (party(field(transfer, 'sender')) !== sender) refuse('the transfer is from another sender');
  if (party(field(transfer, 'receiver')) !== asked.toParty) refuse('the transfer is to another receiver');
  if (numeric(field(transfer, 'amount')) !== canonicalDecimal(asked.amount)) refuse('the transfer moves another amount');
  const instrument = field(transfer, 'instrumentId');
  if (party(field(instrument, 'admin')) !== asked.asset.admin || textOf(field(instrument, 'id')) !== asked.asset.id) refuse('the transfer moves another instrument');
  if (!sameSet(cids(field(transfer, 'inputHoldingCids')), o.stated)) refuse('the transfer spends other holdings than stated');
  const before = field(transfer, 'executeBefore');
  if (before.t !== 'timestamp' || BigInt(before.v) !== BigInt(o.executeBefore) * 1_000_000n) refuse('executeBefore is not the stated one');
  checkTransferSubtree(tx, node, o);
}

/**
 * What the factory does under the root of `holdings.transfer` (sdk#105
 * review): pinned factory, only the stated inputs consumed, every holding
 * accounted for, the receiver credited exactly the amount, the change bounded.
 */
function checkTransferSubtree(tx: CantonTransaction, root: ExerciseNode, o: TransferExpectation): void {
  const { sender, asked } = o;
  const f = (o.factories[asked.asset.admin] ?? []).find((e) => root.templateId === `${e.packageId}:${e.factory}`);
  if (!f) return refuse(`the transfer factory ${root.templateId} is not a pinned factory of the admin ${asked.asset.admin}`);
  const pinned = (t: string, entity: string) => t === `${f.packageId}:${entity}`;
  const sameInstrument = (h: HoldingSeen) => h.admin === asked.asset.admin && h.id === asked.asset.id;
  const amount = scaled(asked.amount);

  // The stated inputs, as the transaction discloses them: the sender's unlocked holdings of the instrument.
  let inputs = 0n;
  for (const cid of o.stated) {
    const disclosed = tx.inputContracts.find((c) => c.contractId === cid);
    if (!disclosed) return refuse(`the stated input ${cid} is not disclosed with the transaction`);
    if (!pinned(disclosed.templateId, f.holding)) refuse(`the stated input ${cid} is not a holding of the pinned registry`);
    const h = holdingOf(disclosed.argument, f);
    if (h.owner !== sender || !sameInstrument(h) || h.locked) refuse(`the stated input ${cid} is not an unlocked holding of the sender in the instrument`);
    inputs += h.amount;
  }
  if (inputs < amount) refuse(`the stated inputs hold ${decimal(inputs)}, less than ${decimal(amount)}`);

  const nodes = subtree(tx, root.nodeId);
  const archived = new Set<string>();
  let receiver = 0n;
  let locked = 0n;
  let change = 0n;
  const offers: DamlValue[] = [];
  for (const node of nodes) {
    if (node === root) continue;
    if (node.kind === 'rollback') return refuse('a rollback node inside the transfer');
    if (node.kind === 'exercise' && node.stakeholders.includes(sender)) {
      const name = `${qualified(node.templateId)}.${node.choice}`;
      if (node.consuming && node.choice === 'Archive' && pinned(node.templateId, f.holding) && o.stated.includes(node.contractId)) {
        if (archived.has(node.contractId)) refuse(`the stated input ${node.contractId} is archived twice`);
        archived.add(node.contractId);
      } else if (!f.serviceChoices.includes(name)) {
        refuse(`the transfer exercises ${name} on ${node.contractId}, a contract of the sender that is not a stated input`);
      }
    }
    if (node.kind !== 'create') continue;
    if (pinned(node.templateId, f.holding)) {
      const h = holdingOf(node.argument, f);
      if (!sameInstrument(h)) refuse(`the transfer creates a holding of another instrument (${h.admin} ${h.id})`);
      if (h.owner === asked.toParty && !h.locked) receiver += h.amount;
      else if (h.owner === sender && h.locked) locked += h.amount;
      else if (h.owner === sender) change += h.amount;
      else refuse(`the transfer creates a holding owned by a third party (${String(h.owner)})`);
    } else if (pinned(node.templateId, f.offer)) {
      offers.push(node.argument);
    } else if (node.stakeholders.includes(sender)) {
      refuse(`the transfer creates ${qualified(node.templateId)} for the sender`);
    } else if (node.argument.t === 'record' && 'owner' in node.argument.v && optionalParty(node.argument.v.owner) !== asked.toParty) {
      refuse(`the transfer creates a contract owned by a third party (${qualified(node.templateId)})`);
    }
  }
  const unspent = o.stated.filter((cid) => !archived.has(cid));
  if (unspent.length > 0) refuse(`the stated inputs ${unspent.join(', ')} are not spent`);

  if (offers.length === 0) {
    if (receiver !== amount) refuse(`the receiver is credited ${decimal(receiver)}, not ${decimal(amount)}`);
    if (locked !== 0n) refuse(`a direct transfer locks ${decimal(locked)} of the sender`);
  } else {
    if (o.completedOnly) refuse('a pending transfer is not a delivery: the receiver must be credited in this transaction');
    if (offers.length > 1) refuse(`the transfer creates ${offers.length} pending transfers`);
    if (receiver !== 0n) refuse(`a pending transfer credits the receiver ${decimal(receiver)} already`);
    if (locked !== amount) refuse(`a pending transfer locks ${decimal(locked)} of the sender, not ${decimal(amount)}`);
    const t = field(offers[0] as DamlValue, 'transfer');
    if (accountOwner(field(t, 'sender')) !== sender || accountOwner(field(t, 'receiver')) !== asked.toParty) refuse('the pending transfer names another sender or receiver');
    if (scaled(numeric(field(t, 'amount'))) !== amount) refuse('the pending transfer moves another amount');
    const instrument = field(t, 'instrumentId');
    if (party(field(instrument, 'admin')) !== asked.asset.admin || textOf(field(instrument, 'id')) !== asked.asset.id) refuse('the pending transfer moves another instrument');
  }
  if (change > inputs - amount) refuse(`change ${decimal(change)} is more than the inputs minus the amount, ${decimal(inputs - amount)}`);
}
