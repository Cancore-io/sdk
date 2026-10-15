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
 *   token standard's TransferFactory, acting as the party alone, sending the
 *   asked amount of the asked instrument to the asked party, spending only the
 *   stated holdings; no contract anywhere in it is created for a third party.
 *
 * `delivery.fill` and `intent.settle` check against the node's ticket and
 * order and come with those flows (CAN-1867, CAN-2321).
 */
import type { CantonOpParams, Hex } from '@cancore/contracts';
import { CantonRefusal, cantonFingerprint } from './legs';
import type { CantonOpCheck } from './operations';
import type { CantonTransaction, DamlValue, ExerciseNode, TransactionNode } from './transaction';

const REGISTRY_MODULE = 'Intent.FillerRegistry';
const TRANSFER_FACTORY = 'Splice.Api.Token.TransferInstructionV1:TransferFactory';

const refuse = (detail: string): never => {
  throw new CantonRefusal('-', detail);
};

/** `<module>:<entity>` of a `<package id>:<module>:<entity>` id. */
const qualified = (templateId: string | undefined): string => (templateId ?? '').split(':').slice(1).join(':');

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

function field(value: DamlValue | undefined, name: string): DamlValue {
  if (value?.t !== 'record' || !(name in value.v)) return refuse(`no field ${name}`);
  return value.v[name] as DamlValue;
}
const party = (v: DamlValue): string => (v.t === 'party' ? v.v : refuse('expected a party'));
const textOf = (v: DamlValue): string => (v.t === 'text' ? v.v : refuse('expected text'));
const numeric = (v: DamlValue): string => (v.t === 'numeric' ? canonicalDecimal(v.v) : refuse('expected a decimal'));
const cids = (v: DamlValue): string[] => (v.t === 'list' ? v.v.map((x) => (x.t === 'contractId' ? x.v : refuse('expected a contract id'))) : refuse('expected a list'));

/** The one transaction of the op and its one root, an exercise. */
function soleRoot(transactions: readonly CantonTransaction[]): { tx: CantonTransaction; root: ExerciseNode } {
  if (transactions.length !== 1) refuse(`expected one transaction, got ${transactions.length}`);
  const tx = transactions[0] as CantonTransaction;
  if (tx.roots.length !== 1) refuse(`expected one root, got ${tx.roots.length}`);
  const root = tx.nodes[tx.roots[0] as string];
  if (root?.kind !== 'exercise') return refuse('the root is not an exercise');
  return { tx, root };
}

/** Every node under `root`, root included; a node id missing from the transaction is refused. */
function subtree(tx: CantonTransaction, rootId: string): TransactionNode[] {
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

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

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
export function checkHoldingsTransfer(expect: { params: CantonOpParams['holdings.transfer']; publicKey: Hex; nowMs: number }): CantonOpCheck<'holdings.transfer'> {
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
    if (qualified(root.interfaceId) !== TRANSFER_FACTORY || root.choice !== 'TransferFactory_Transfer') refuse('the root is not TransferFactory_Transfer');
    if (party(field(root.chosenValue, 'expectedAdmin')) !== asked.asset.admin) refuse('the factory is for another instrument admin');
    const transfer = field(root.chosenValue, 'transfer');
    if (party(field(transfer, 'sender')) !== sender) refuse('the transfer is from another sender');
    if (party(field(transfer, 'receiver')) !== asked.toParty) refuse('the transfer is to another receiver');
    if (numeric(field(transfer, 'amount')) !== canonicalDecimal(asked.amount)) refuse('the transfer moves another amount');
    const instrument = field(transfer, 'instrumentId');
    if (party(field(instrument, 'admin')) !== asked.asset.admin || textOf(field(instrument, 'id')) !== asked.asset.id) refuse('the transfer moves another instrument');
    if (!sameSet(cids(field(transfer, 'inputHoldingCids')), s.inputHoldingCids)) refuse('the transfer spends other holdings than stated');
    const before = field(transfer, 'executeBefore');
    if (before.t !== 'timestamp' || BigInt(before.v) !== BigInt(s.executeBefore) * 1_000_000n) refuse('executeBefore is not the stated one');
    if (BigInt(s.executeBefore) * 1000n <= BigInt(expect.nowMs)) refuse('executeBefore has passed');
    // No contract anywhere in it may belong to a third party: an `owner` field names the party or the receiver.
    for (const node of Object.values(tx.nodes)) {
      if (node.kind !== 'create' || node.argument.t !== 'record' || !('owner' in node.argument.v)) continue;
      const owner = party(node.argument.v.owner as DamlValue);
      if (owner !== sender && owner !== asked.toParty) refuse(`the transfer creates a contract owned by a third party (${qualified(node.templateId)})`);
    }
  };
}
