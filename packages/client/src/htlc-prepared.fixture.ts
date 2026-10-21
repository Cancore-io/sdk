/**
 * Prepared self-custody HTLC transactions as the participant returns them, for the tests: the Flow B
 * `HTLCInitRequest` create and the counter `Proposal_Accept`, built from the backend's own command
 * builders (`init-request-command.builder.ts`, `accept-command.builder.ts`) and the Daml templates
 * (`htlc/daml/HTLC/InitRequest.daml`, `HTLC.daml`). Test-only; no entry point imports it.
 */
import type { Create, DamlTransaction_Node, Value } from '@canton-network/core-ledger-proto';
import { DEFAULT_ESCROWS, DEFAULT_FEE_RECIPIENTS, DEFAULT_VENUES } from './dvp-admins';
import { DEFAULT_TRUSTED_PACKAGES } from './dvp-verify';
import { createNode, createOf, DEV, node, numeric10, PKG, prepared, template, v, type NodeType } from './dvp-prepared.fixture';

export const HTLC_PACKAGE = { name: 'htlc-contract-v9', id: DEFAULT_TRUSTED_PACKAGES.htlc['htlc-contract-v9']!.at(-1)! };
export const ESCROW = DEFAULT_ESCROWS.devnet[0]!;
export const FEE_PARTY = DEFAULT_FEE_RECIPIENTS.devnet[0]!;
export const EXECUTOR = DEFAULT_VENUES.devnet;
export const HASH_LOCK = 'ab'.repeat(32);
export const INIT_CID = 'c1'.repeat(34);
export const PROPOSAL_CID = 'c2'.repeat(34);
export const HTLC_CID = 'c3'.repeat(34);

export const some = (value: Value): Value => ({ sum: { oneofKind: 'optional', optional: { value } } });
export const iso = (ms: number) => new Date(ms).toISOString();
const instrumentValue = (i: { id: string; admin: string }) => v.record({ admin: v.party(i.admin), id: v.text(i.id) });

export interface InitRequest {
  party: string;
  receiver: string;
  amount: string;
  instrument: { id: string; admin: string };
  hashLock: string;
  timeout: string;
  escrow: string;
  executor: string;
  fee: string;
  maxFeeRate: string;
  provider: string | null;
  description: string;
}

export const initRequestFields = (r: InitRequest): Record<string, Value> => ({
  escrowParty: v.party(r.escrow),
  executorParty: v.party(r.executor),
  feeParty: v.party(r.fee),
  sender: v.party(r.party),
  receiver: v.party(r.receiver),
  hashLock: v.text(r.hashLock),
  amount: v.numeric(numeric10(r.amount)),
  instrumentId: instrumentValue(r.instrument),
  timeout: v.time(r.timeout),
  description: v.text(r.description),
  maxFeeRate: v.numeric(numeric10(r.maxFeeRate)),
  provider: r.provider ? some(v.party(r.provider)) : v.none(),
});

/** The `escrow` leg of Flow B: one `HTLCInitRequest` create, signed by the sender. The overrides are what a hostile API would hand over. */
export async function initRequestLeg(r: InitRequest, over: {
  fields?: (fields: Record<string, Value>) => void; signatories?: string[];
  packageName?: string; packageId?: string; moduleName?: string; entityName?: string;
  /** Nodes added as further roots: commands beside the create. */
  extraRoots?: DamlTransaction_Node[];
} = {}) {
  const fields = initRequestFields(r);
  over.fields?.(fields);
  const signatories = over.signatories ?? [r.party];
  const create: Create = {
    ...createOf(INIT_CID, over.packageName ?? HTLC_PACKAGE.name, over.packageId ?? HTLC_PACKAGE.id, over.moduleName ?? 'HTLC.InitRequest',
      over.entityName ?? 'HTLCInitRequest', v.record(fields), signatories),
    stakeholders: [...signatories, r.escrow, r.fee, r.executor],
  };
  const extra = (over.extraRoots ?? []).map((n, i) => ({ ...n, nodeId: String(i + 1) }));
  return { kind: 'escrow', ...(await prepared(r.party, [createNode('0', create), ...extra], [], ['0', ...extra.map((n) => n.nodeId)])) };
}

export interface Proposal {
  party: string;
  sender: string;
  amount: string;
  instrument: { id: string; admin: string };
  hashLock: string;
  timeout: string;
  escrow: string;
  executor: string;
  fee: string;
  feeAmount: string | null;
  provider: string | null;
  description: string;
}

export const proposalParams = (p: Proposal): Record<string, Value> => ({
  escrowParty: v.party(p.escrow),
  executorParty: v.party(p.executor),
  feeParty: v.party(p.fee),
  hashLock: v.text(p.hashLock),
  amount: v.numeric(numeric10(p.amount)),
  instrumentId: instrumentValue(p.instrument),
  allocationCid: v.none(),
  receiver: v.party(p.party),
  sender: v.party(p.sender),
  timeout: v.time(p.timeout),
  description: v.text(p.description),
  feeAmount: p.feeAmount ? some(v.numeric(numeric10(p.feeAmount))) : v.none(),
  feeAllocationCid: v.none(),
  provider: p.provider ? some(v.party(p.provider)) : v.none(),
});

type ExerciseNode = Extract<NodeType, { oneofKind: 'exercise' }>['exercise'];

/**
 * The counter leg's accept: `Proposal_Accept` on the counter `HTLCProposal`, acting as its receiver,
 * creating the `HTLC` (a Flow B counter carries no allocation, so nothing else runs). The overrides
 * are what a hostile API would hand over.
 */
export async function acceptCounterLeg(p: Proposal, over: {
  params?: (params: Record<string, Value>) => void;
  record?: (record: Record<string, Value>) => void;
  htlcParams?: (params: Record<string, Value>) => void;
  argument?: (argument: Record<string, Value>) => void;
  command?: (command: ExerciseNode) => void;
  proposalPackageId?: string; htlcPackageId?: string; htlcEntity?: string;
  /** The proposal is not disclosed; or another contract stands under its id. */
  disclose?: false | ((honest: Create) => Create);
  /** Children of the accept besides the HTLC create (0 = no HTLC at all, 2 = two). */
  htlcs?: number;
  extraChildren?: DamlTransaction_Node[];
  extraInputs?: Create[];
} = {}) {
  const params = proposalParams(p);
  over.params?.(params);
  const proposalRecord: Record<string, Value> = { params: v.record(params), createdAt: v.time(iso(Date.now() - 60_000)) };
  over.record?.(proposalRecord);
  const signers = [p.escrow, p.fee, p.executor, p.sender];
  const proposal: Create = {
    ...createOf(PROPOSAL_CID, HTLC_PACKAGE.name, over.proposalPackageId ?? HTLC_PACKAGE.id, 'HTLC.HTLC', 'HTLCProposal', v.record(proposalRecord), signers),
    stakeholders: [...signers, p.party, ...(p.provider ? [p.provider] : [])],
  };
  const htlcValues = proposalParams(p);
  over.htlcParams?.(htlcValues);
  const htlcSigners = [p.escrow, p.fee, p.sender, p.party];
  const htlc = (n: number): DamlTransaction_Node => createNode(String(n + 1), {
    ...createOf(n === 0 ? HTLC_CID : `c${n + 3}`.repeat(34), HTLC_PACKAGE.name, over.htlcPackageId ?? HTLC_PACKAGE.id, 'HTLC.HTLC', over.htlcEntity ?? 'HTLC',
      v.record({ params: v.record(htlcValues), createdAt: v.time(iso(Date.now())) }), htlcSigners),
    stakeholders: [...htlcSigners, p.executor, ...(p.provider ? [p.provider] : [])],
  });
  const htlcs = Array.from({ length: over.htlcs ?? 1 }, (_, i) => htlc(i));
  const extra = (over.extraChildren ?? []).map((n, i) => ({ ...n, nodeId: String(htlcs.length + i + 1) }));
  const argument: Record<string, Value> = { acceptFactoryCid: v.none(), acceptExpectedAdmin: v.none(), acceptExtraArgs: v.none() };
  over.argument?.(argument);
  const command: ExerciseNode = {
    lfVersion: '2.1', contractId: PROPOSAL_CID, packageName: HTLC_PACKAGE.name, templateId: template('HTLC.HTLC', 'HTLCProposal', over.proposalPackageId ?? HTLC_PACKAGE.id),
    signatories: signers, stakeholders: proposal.stakeholders, actingParties: [p.party],
    choiceId: 'Proposal_Accept', chosenValue: v.record(argument), consuming: true,
    children: [...htlcs, ...extra].map((n) => n.nodeId), choiceObservers: [],
  };
  over.command?.(command);
  const disclosed = over.disclose === false ? [] : [over.disclose ? over.disclose(proposal) : proposal];
  const root = node('0', { oneofKind: 'exercise', exercise: command });
  return { kind: 'escrow', ...(await prepared(p.party, [root, ...htlcs, ...extra], [...disclosed, ...(over.extraInputs ?? [])])) };
}

/**
 * CC's own transfer instruction in place of the registry's offer: a Flow B CC deposit is a
 * `TransferFactory_Transfer` on the DSO's ExternalPartyAmuletRules, and the offer it leaves names
 * the DSO, the sender and the receiver — no registry operator.
 */
export const amuletInstruction = (honest: Create): Create => {
  const transfer = honest.argument?.sum.oneofKind === 'record' ? honest.argument.sum.record.fields.find((f) => f.label === 'transfer')?.value : undefined;
  return {
    ...honest,
    packageName: 'splice-amulet',
    templateId: template('Splice.AmuletTransferInstruction', 'AmuletTransferInstruction', PKG.amulet),
    argument: v.record({ transfer: transfer ?? v.record({}) }),
    signatories: [DEV.dso, ...honest.signatories.filter((p) => p !== DEV.dso)],
  };
};
