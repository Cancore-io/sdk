/**
 * The stand's attestor daemons and the ledger transactions their proofs are held to (CAN-2146): what each daemon
 * answers on `GET /attest/{sourceChainId}/{orderHash}` (attestor src/api.ts), and the committed transaction of a
 * delivery or a settlement in its LEDGER_EFFECTS shape, exercises with their arguments.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Hex } from '@cancore/contracts';
import { cantonToken, ledger } from './canton-ledger';

/** `ICancoreRouter.FillProof` as `GET /attest` renders it: uint256/uint64 as decimal strings (attestor src/types.ts). */
export interface AttestedFillProof {
  kind: number;
  orderHash: Hex;
  destination: Hex;
  fillRef: Hex;
  recipient: Hex;
  outputAsset: Hex;
  amountDelivered: string;
  filledAt: string;
  fillerId: Hex;
  repayTo: Hex;
  attempt: number;
  setId: number;
}

/** A daemon's 200 answer; a Canton-source signature is minimal DER and comes with the signer's SPKI as `pubKey`. */
export interface Attestation {
  attestor: string;
  proof: AttestedFillProof;
  signature: Hex;
  signer: string;
  setId: number;
  pubKey?: Hex;
}

// The stand's router runs a 2-of-3 set: ATTESTOR1..3 of Cancore-io/meta docs/runbooks/intent-stand.md.
const STAND_ATTESTORS = ['attestor1', 'attestor2', 'attestor3'] as const;

// The stand publishes no host port for the daemons (meta docker/modules/attestor/compose.yaml), so the request runs
// inside each daemon's own container, as the attestor's stand suite does (attestor test/stand/ci.sh).
const GET_OWN_API = "fetch('http://127.0.0.1:'+process.env.ATTESTOR_PORT+process.argv[1]).then(async(r)=>process.stdout.write(JSON.stringify({status:r.status,body:await r.text()})))";
const run = promisify(execFile);

async function askAttestor(container: string, path: string): Promise<{ status: number; body: string }> {
  const { stdout } = await run('docker', ['exec', container, 'node', '-e', GET_OWN_API, path], { timeout: 30_000 });
  return JSON.parse(stdout) as { status: number; body: string };
}

/** Every stand daemon's signed answer for the order; fails naming each daemon's last answer once `timeoutMs` passes. */
export async function attestationsOf(sourceChainId: string, orderHash: Hex, timeoutMs = 3 * 60_000): Promise<Attestation[]> {
  const suffix = process.env.STACK_SUFFIX ?? '';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answers = await Promise.all(STAND_ATTESTORS.map(async (attestor) => ({ attestor, ...(await askAttestor(`${attestor}${suffix}`, `/attest/${sourceChainId}/${orderHash}`)) })));
    if (answers.every((a) => a.status === 200)) return answers.map((a) => ({ attestor: a.attestor, ...(JSON.parse(a.body) as Omit<Attestation, 'attestor'>) }));
    if (Date.now() > deadline) throw new Error(`not every stand attestor signed ${orderHash}: ${answers.map((a) => `${a.attestor} ${a.status} ${a.body.slice(0, 300)}`).join('; ')}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/** A Daml `Bytes32` as the JSON API renders it — `{hex}` without `0x`, or a plain string — as `0x` lowercase hex. */
export const bytes32Hex = (value: unknown): Hex => {
  const hex = typeof value === 'string' ? value : (value as { hex?: unknown } | null)?.hex;
  if (typeof hex !== 'string') throw new Error(`not a Bytes32: ${JSON.stringify(value)}`);
  return `0x${hex.replace(/^0x/i, '').toLowerCase()}`;
};

/** A POST to the stand's JSON Ledger API v2 under the spec's own login. */
export type LedgerPost = (path: string, body: unknown) => Promise<unknown>;

export const standLedger: LedgerPost = async (path, body) => ledger(path, await cantonToken(), body);

export interface LedgerEffect {
  ExercisedEvent?: { contractId: string; templateId: string; choice: string; choiceArgument: Record<string, unknown> };
  CreatedEvent?: { contractId: string; templateId: string; createArgument: Record<string, unknown> };
}

const everythingOf = (party: string) => ({
  filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } },
  verbose: true,
});

/** The committed transaction `updateId` as `party` sees it; throws when the participant shows no such transaction. */
export async function ledgerEffects(post: LedgerPost, updateId: string, party: string): Promise<LedgerEffect[]> {
  const answer = (await post('/v2/updates/update-by-id', {
    updateId,
    updateFormat: { includeTransactions: { transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS', eventFormat: everythingOf(party) } },
  })) as { update?: { Transaction?: { value?: { events?: LedgerEffect[] } } } } | null;
  const events = answer?.update?.Transaction?.value?.events;
  if (!events) throw new Error(`update ${updateId} is no transaction ${party} sees: ${JSON.stringify(answer).slice(0, 300)}`);
  return events;
}

/** A contract's create argument as `party` sees it, archived or not. */
export async function createArgumentOf(post: LedgerPost, contractId: string, party: string): Promise<Record<string, unknown>> {
  const answer = (await post('/v2/events/events-by-contract-id', { contractId, eventFormat: everythingOf(party) })) as { created?: { createdEvent?: { createArgument?: Record<string, unknown> } } } | null;
  const argument = answer?.created?.createdEvent?.createArgument;
  if (!argument) throw new Error(`contract ${contractId} is not visible to ${party}`);
  return argument;
}
