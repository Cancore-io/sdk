/**
 * Check a self-custody HTLC transaction before the account's key signs it (CAN-2929).
 *
 * Two ceremonies, read as every other one is (the hash recomputed from the bytes, the account the only
 * party acting, the whole tree walked — `openLeg`), and held to what the account asked for, never to
 * what the API says about it:
 *
 *  - Flow B (`htlc.flow-b-create`): the `HTLCInitRequest` the account signs alone, and the deposit that
 *    funds it. The request is the ceiling of what the venue may later allocate from the account
 *    (`InitRequest_Execute` is bounded by its amount, escrow, executor and fee rate), so every field is
 *    held to the call and to the pinned Cancore parties; the deposit is a send of exactly that amount to
 *    exactly that escrow.
 *  - accept-counter (`htlc.accept-counter`): `Proposal_Accept` on the counter `HTLCProposal`, which makes
 *    the account a signatory of the counter HTLC. The proposal must be the one the account expects
 *    (amount, instrument, its own hash lock, a timeout that leaves a claim margin), and the accept must
 *    create that HTLC and nothing the account pays for or signs besides it.
 *
 * Unknown templates, choices, fields and leg kinds are refused, not skipped. The threat each check
 * answers is named in the ticket (F1–F21, A1–A15).
 */
import type { Value } from '@canton-network/core-ledger-proto';
import { instrumentKey } from './dvp-admins';
import {
  CLOCK_SKEW_MS, decimalOf, fieldsOf, holdingOf, nodeType, numericOf, openLeg, partyOf, refuser, sameTemplate, sendCost, signerBounds,
  textOf, trusted, units, type Create, type Leg, type Opened, type Refuse,
} from './dvp-verify';

/** The parties and packages a self-custody HTLC may name, pinned per network (see `dvp-admins.ts`). */
export interface HtlcPins {
  escrows: readonly string[];
  /** The venue: the split pools' executor. */
  executors: readonly string[];
  feeParties: readonly string[];
  /** Who a request may name as its CIP-0104 provider (an observer); None is always allowed. */
  providers: readonly string[];
  /** `htlc-contract-*` package name → the ids trusted under it. */
  packages: Record<string, readonly string[]>;
}

export interface FlowBTerms extends HtlcPins {
  /** The account: the request's sender and the deposit's payer. */
  party: string;
  receiver: string;
  amount: string;
  /** The instrument id as the ledger names it (`Amulet` for CC). */
  instrument: string;
  /** The instrument's pinned admins. */
  admins: string[];
  /** The account's own hash lock: lowercase hex SHA-256 of its preimage. */
  hashLock: string;
  timeoutHours: number;
  /** The highest fee rate the account lets the request allow. */
  maxFeeRate: string;
  now?: number;
  /** The deposit's CC fee ceiling, fee recipients and CC admins (the `sendCost` rules). */
  maxFee: string;
  feeRecipients: string[];
  dso: string[];
}

export interface AcceptCounterTerms extends HtlcPins {
  /** The account: the counter proposal's receiver. */
  party: string;
  amount: string;
  instrument: string;
  admins: string[];
  hashLock: string;
  /** Epoch ms: a counter that times out before this leaves no time to claim it. */
  minTimeout: number;
  now?: number;
}

const INIT_REQUEST_FIELDS = [
  'escrowParty', 'executorParty', 'feeParty', 'sender', 'receiver', 'hashLock', 'amount', 'instrumentId', 'timeout', 'description', 'maxFeeRate', 'provider',
];
const HTLC_PARAMS_FIELDS = [
  'escrowParty', 'executorParty', 'feeParty', 'hashLock', 'amount', 'instrumentId', 'allocationCid', 'receiver', 'sender', 'timeout', 'description',
  'feeAmount', 'feeAllocationCid', 'provider',
];
const PROPOSAL_FIELDS = ['params', 'createdAt'];
const ACCEPT_ARGUMENTS = ['acceptFactoryCid', 'acceptExpectedAdmin', 'acceptExtraArgs'];
/** Fields an accepted HTLC may hold differently from its proposal: the allocations the accept re-escrows. */
const REESCROWED = new Set(['allocationCid', 'feeAllocationCid']);

/** Verify the Flow B ceremony — the escrow request and, unless the instrument has none, its deposit. */
export async function verifyHtlcFlowBPrepared(legs: Leg[], terms: FlowBTerms): Promise<void> {
  const refuse = refuser('htlc.flow-b-create');
  if (legs.length === 0) refuse('the API prepared nothing to sign');
  legs.forEach((leg, i) => {
    if (leg.kind !== 'escrow' && leg.kind !== 'transfer') refuse(`leg ${i} is a ${leg.kind}, not the escrow request or its deposit`);
  });
  const requests = legs.filter((l) => l.kind === 'escrow');
  const deposits = legs.filter((l) => l.kind === 'transfer');
  if (requests.length !== 1) refuse(`expected one escrow request, got ${requests.length}`);
  if (deposits.length > 1) refuse(`expected at most one deposit, got ${deposits.length}`);

  const what = 'the escrow request';
  const opened = await openLeg(requests[0]!, what, terms.party, refuse);
  if (opened.root?.oneofKind !== 'create') return refuse(`${what} is not a create`);
  const create = opened.root.create;
  const id = create.templateId;
  if (!trusted(terms.packages as Record<string, string[]>, create.packageName, id?.packageId) || id?.moduleName !== 'HTLC.InitRequest' || id.entityName !== 'HTLCInitRequest') {
    refuse(`${what} is not an HTLCInitRequest of a trusted htlc package`);
  }
  if (create.signatories.length !== 1 || create.signatories[0] !== terms.party) {
    refuse(`${what} is signed by ${create.signatories.join(', ')}, not by this account alone`);
  }
  const fields = exactFields(create.argument, INIT_REQUEST_FIELDS, what, refuse, 'fields');
  const sender = partyOf(fields.get('sender'));
  if (sender !== terms.party) refuse(`${what} sends from ${String(sender)}, not from this account`);
  const receiver = partyOf(fields.get('receiver'));
  if (receiver !== terms.receiver) refuse(`${what} pays ${String(receiver)}, not ${terms.receiver}`);
  checkLock(fields, what, terms, refuse);
  const now = terms.now ?? Date.now();
  const timeout = timeOf(fields.get('timeout'));
  const due = now + terms.timeoutHours * 3_600_000;
  if (timeout === undefined || Math.abs(timeout - due) > CLOCK_SKEW_MS) {
    refuse(`${what} times out at ${timeout === undefined ? 'an unreadable time' : new Date(timeout).toISOString()}, not ${terms.timeoutHours} hours from now`);
  }
  checkParties(fields, what, terms, refuse);
  const rate = units(numericOf(fields.get('maxFeeRate')));
  if (rate < 0n || rate > units(terms.maxFeeRate)) {
    refuse(`${what} allows a fee rate of ${rate < 0n ? 'an unreadable value' : decimalOf(rate)}, above this account's ${terms.maxFeeRate}`);
  }

  if (deposits.length === 1) {
    // The escrow the request names is the only party the deposit may pay, and exactly its amount.
    const escrow = partyOf(fields.get('escrowParty'))!;
    await sendCost(deposits, {
      party: terms.party, admins: terms.admins, dso: terms.dso, instrument: terms.instrument, receiver: escrow, amount: terms.amount,
      maxFee: terms.maxFee, feeRecipients: terms.feeRecipients,
    }, 'htlc.flow-b-create');
  }
}

/** Verify the counter accept: one `Proposal_Accept` on the expected counter proposal, creating its HTLC and nothing else of the account's. */
export async function verifyHtlcAcceptCounterPrepared(legs: Leg[], terms: AcceptCounterTerms): Promise<void> {
  const refuse = refuser('htlc.accept-counter');
  if (legs.length !== 1) refuse(`expected one transaction, got ${legs.length}`);
  const what = 'the accept';
  const opened = await openLeg(legs[0]!, what, terms.party, refuse);
  if (opened.root?.oneofKind !== 'exercise') return refuse(`${what} is not Proposal_Accept on an HTLCProposal of a trusted htlc package`);
  const command = opened.root.exercise;
  if (command.choiceId !== 'Proposal_Accept' || !isHtlcTemplate(command, 'HTLCProposal', terms)) {
    refuse(`${what} is not Proposal_Accept on an HTLCProposal of a trusted htlc package`);
  }
  if (!command.consuming) refuse(`${what} does not consume the proposal`);
  if (command.actingParties.length !== 1 || command.actingParties[0] !== terms.party) {
    refuse(`${what} acts as ${command.actingParties.join(', ')}, not as this account alone`);
  }
  const proposal = opened.inputs.get(command.contractId);
  if (!proposal) return refuse(`${what} does not disclose the proposal it accepts`);
  if (!sameTemplate(proposal, command)) refuse(`${what} runs on another template than the proposal it names`);

  const params = proposalParams(proposal, refuse);
  const receiver = partyOf(params.get('receiver'));
  if (receiver !== terms.party) refuse(`the proposal is to ${String(receiver)}, not to this account`);
  checkLock(params, 'the proposal', terms, refuse);
  const timeout = timeOf(params.get('timeout'));
  if (timeout === undefined || timeout < terms.minTimeout) {
    refuse(`the proposal times out at ${timeout === undefined ? 'an unreadable time' : new Date(timeout).toISOString()}, ` +
      `before ${new Date(terms.minTimeout).toISOString()}, the claim margin this account needs`);
  }
  checkParties(params, 'the proposal', terms, refuse);

  const argument = exactFields(command.chosenValue, ACCEPT_ARGUMENTS, what, refuse, 'arguments');
  const expected = argument.get('acceptExpectedAdmin');
  const admin = expected?.sum.oneofKind === 'optional' ? partyOf(expected.sum.optional.value) : undefined;
  if (expected?.sum.oneofKind !== 'optional' || (expected.sum.optional.value && (!admin || !terms.admins.includes(admin)))) {
    refuse(`${what} expects ${String(admin)} as the instrument admin, which is not a pinned one`);
  }

  checkAcceptTree(opened, command.contractId, params, what, terms, refuse);
}

/** A record holding exactly `labels`: one this SDK does not read is refused, and so is one that is missing. */
function exactFields(value: Value | undefined, labels: string[], what: string, refuse: Refuse, noun: string): Map<string, Value> {
  const fields = fieldsOf(value);
  if (!fields) return refuse(`${what} is not a record this SDK reads`);
  const unknown = [...fields.keys()].filter((label) => !labels.includes(label));
  if (unknown.length > 0) refuse(`${what} has ${noun} this SDK does not read: ${unknown.join(', ')}`);
  const missing = labels.filter((label) => !fields.has(label));
  if (missing.length > 0) refuse(`${what} is missing ${missing.join(', ')}`);
  return fields;
}

/** The proposal contract's params, with the contract and the params both held to their exact fields. */
function proposalParams(proposal: Create, refuse: Refuse): Map<string, Value> {
  const record = exactFields(proposal.argument, PROPOSAL_FIELDS, 'the proposal contract', refuse, 'fields');
  return exactFields(record.get('params'), HTLC_PARAMS_FIELDS, 'the proposal', refuse, 'fields');
}

/** Amount, hash lock and instrument: what the HTLC locks, and against which secret. */
function checkLock(fields: Map<string, Value>, what: string, terms: { amount: string; hashLock: string; instrument: string; admins: string[] }, refuse: Refuse): void {
  const amount = units(numericOf(fields.get('amount')));
  if (amount !== units(terms.amount)) refuse(`${what} locks ${amount < 0n ? 'an unreadable amount' : decimalOf(amount)}, not ${terms.amount}`);
  if (textOf(fields.get('hashLock')) !== terms.hashLock) refuse(`${what} is locked to another hash than the account's`);
  const instrument = fieldsOf(fields.get('instrumentId'));
  const [id, admin] = [textOf(instrument?.get('id')), partyOf(instrument?.get('admin'))];
  if (!id || instrumentKey(id) !== instrumentKey(terms.instrument) || !admin || !terms.admins.includes(admin)) {
    refuse(`${what} locks ${String(id)} of ${String(admin)}, not ${terms.instrument} of a pinned admin`);
  }
}

/** The split pool's escrow, executor and fee party, and the optional provider: each one Cancore pins. */
function checkParties(fields: Map<string, Value>, what: string, pins: HtlcPins, refuse: Refuse): void {
  const escrow = partyOf(fields.get('escrowParty'));
  if (!escrow || !pins.escrows.includes(escrow)) refuse(`${what} names ${String(escrow)} as escrow, which is not a pinned Cancore escrow party`);
  const executor = partyOf(fields.get('executorParty'));
  if (!executor || !pins.executors.includes(executor)) refuse(`${what} names ${String(executor)} as executor, which is not the pinned venue`);
  const fee = partyOf(fields.get('feeParty'));
  if (!fee || !pins.feeParties.includes(fee)) refuse(`${what} names ${String(fee)} as fee party, which is not a pinned Cancore fee party`);
  const provider = fields.get('provider');
  const named = provider?.sum.oneofKind === 'optional' ? provider.sum.optional.value : provider;
  if (provider?.sum.oneofKind !== 'optional' || (named && !pins.providers.includes(partyOf(named) ?? ''))) {
    refuse(`${what} names ${String(partyOf(named))} as provider, which is not a pinned one`);
  }
}

/**
 * The accept's tree: every node on the HTLC package or on a contract an instrument admin signed; the
 * account acts at the root only and spends no holding of its own; exactly one HTLC is created, and it is the
 * proposal's but for the allocations the accept re-escrows.
 */
function checkAcceptTree(
  { nodes, root, inputs, created }: Opened, proposalCid: string, params: Map<string, Value>, what: string, terms: AcceptCounterTerms, refuse: Refuse,
): void {
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type === root) continue;
    const on = type.oneofKind === 'create' ? type.create : inputs.get(contractOf(type)) ?? created.get(contractOf(type));
    const fromHtlc = !!on && trusted(terms.packages as Record<string, string[]>, on.packageName, on.templateId?.packageId) && on.templateId?.moduleName === 'HTLC.HTLC';
    if (!fromHtlc && !on?.signatories.some((p) => terms.admins.includes(p))) {
      refuse(`node ${node.nodeId} runs on a ${on?.templateId?.entityName ?? 'contract'} that is neither the HTLC package's nor the instrument admin's`);
    }
    if (type.oneofKind === 'exercise' && type.exercise.actingParties.includes(terms.party)) refuse(`this account acts below the accept, in node ${node.nodeId}`);
  }
  // The accept may spend the escrow's allocations, never a holding of the account's own. Every target is
  // disclosed: the origin check above refuses a node on a contract it cannot read.
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind !== 'exercise' || !type.exercise.consuming || type === root) continue;
    const target = inputs.get(type.exercise.contractId) ?? created.get(type.exercise.contractId);
    const holding = target && holdingOf(target);
    if (holding && holding.owner === terms.party) refuse(`${what} spends ${decimalOf(holding.amount)} of this account's ${holding.instrument}`);
  }

  const htlcs = [...created.values()].filter((c) => isHtlcTemplate(c, 'HTLC', terms));
  if (htlcs.length !== 1) refuse(`${what} creates ${htlcs.length} HTLCs, not one`);
  const htlc = htlcs[0]!;
  const made = exactFields(fieldsOf(htlc.argument)?.get('params'), HTLC_PARAMS_FIELDS, 'the HTLC it creates', refuse, 'fields');
  const differs = HTLC_PARAMS_FIELDS.find((label) => !REESCROWED.has(label) && JSON.stringify(made.get(label)) !== JSON.stringify(params.get(label)));
  if (differs) refuse(`the HTLC it creates differs from the proposal in ${differs}`);

  // The parties of the proposal, and those of the admin's own contracts the accept re-escrows through.
  const adminContracts = [...inputs.values(), ...created.values()].filter((c) => c.signatories.some((p) => terms.admins.includes(p)));
  const allowed = new Set([
    terms.party, ...terms.admins, ...[...params.values()].flatMap((v) => partiesOf(v)),
    ...adminContracts.flatMap((c) => [...c.signatories, ...c.stakeholders]),
  ]);
  const bounds = signerBounds(nodes, inputs, created, terms.party, terms.admins, proposalCid, allowed, 'accept', (contract) => contract === htlc);
  if (bounds) refuse(`${what}: ${bounds}`);
}

const contractOf = (type: NonNullable<ReturnType<typeof nodeType>>) =>
  type.oneofKind === 'exercise' ? type.exercise.contractId : type.oneofKind === 'fetch' ? type.fetch.contractId : '';

const isHtlcTemplate = (c: { packageName: string; templateId?: { packageId: string; moduleName: string; entityName: string } }, entity: string, pins: HtlcPins) =>
  trusted(pins.packages as Record<string, string[]>, c.packageName, c.templateId?.packageId) && c.templateId?.moduleName === 'HTLC.HTLC' && c.templateId.entityName === entity;

/** A Daml timestamp (microseconds) in epoch milliseconds. */
const timeOf = (value: Value | undefined) => (value?.sum.oneofKind === 'timestamp' ? Number(BigInt(value.sum.timestamp) / 1000n) : undefined);

/** The parties a param names, Optional ones included. */
function partiesOf(value: Value): string[] {
  const inner = value.sum.oneofKind === 'optional' ? value.sum.optional.value : value;
  if (inner?.sum.oneofKind === 'party') return [inner.sum.party];
  const record = fieldsOf(inner);
  return record ? [...record.values()].flatMap(partiesOf) : [];
}
