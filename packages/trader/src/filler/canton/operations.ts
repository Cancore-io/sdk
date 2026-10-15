/**
 * The Canton operations of the filler's own party (protocol §3.19, operator
 * decision T-1): Cancore's backend prepares each operation, the node checks
 * every leg and signs it with its party key, the backend submits. The node
 * never talks to a Ledger API and never signs blind.
 *
 * One operation: `canton.prepare` → verified `canton.prepared` → the checks
 * (`legs.ts`, then the operation's own check of the decoded transactions
 * against what the node itself knows) → one Ed25519 signature per leg →
 * `canton.submit` → verified `canton.submitted`. Over REST: request and
 * answer pair up exactly, a submit is idempotent per `operationId`, and a
 * prepare is never sent twice for one call.
 *
 * Rate classes: a prepare counts in `cantonPrepare` (an hourly budget), a
 * submit in `canton`; a spent budget pauses new prepares only.
 */
import type {
  CantonDeliveryOrder,
  CantonHolding,
  CantonLegTopology,
  CantonLegTransaction,
  CantonOp,
  CantonOpParams,
  CantonParty,
  CantonPrepare,
  CantonPrepared,
  CantonSubmit,
  CantonSubmitted,
  Hex,
} from '@cancore/contracts';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { GatewayError } from '../errors';
import { FillerConfigError } from '../errors';
import { createSealer, type Sealer, type Unsealed } from '../protocol/envelope';
import { GatewayRest } from '../protocol/rest';
import { silentLogger, systemClock, type Clock, type HttpFetch, type Logger } from '../runtime';
import type { QuoteSigner } from '../signer';
import { checkHoldingsTransfer, checkRegistryAccept } from './checks';
import { CantonRefusal, legKind, verifyTopologyLeg, verifyTransactionLeg } from './legs';
import type { CantonTransaction } from './transaction';

/** The filler party's Ed25519 key. Holds the key; the SDK never sees it. */
export interface CantonPartySigner {
  /** 32-byte Ed25519 public key, hex. */
  readonly publicKey: Hex;
  /** A 64-byte Ed25519 signature over exactly `hash`, hex. */
  signHash(hash: Uint8Array): Promise<Hex>;
}

export type PreparedOf<K extends CantonOp> = Extract<CantonPrepared, { op: K }>;
export type SubmittedOf<K extends CantonOp> = Extract<CantonSubmitted, { op: K }>;

/**
 * What an operation checks before anything is signed: the decoded transactions
 * against the node's own knowledge (its ticket, order, holdings, request). It
 * throws `CantonRefusal` to refuse. The summary states the economics; it is
 * never trusted on its own.
 */
export type CantonOpCheck<K extends CantonOp> = (prepared: PreparedOf<K>, transactions: readonly CantonTransaction[]) => void | Promise<void>;

export interface CantonOperationsOptions {
  rest: Pick<GatewayRest, 'postCanton' | 'getCantonParty' | 'listCantonHoldings' | 'listCantonDeliveryOrders'>;
  /** Seals every filler → filler-gateway message with the message key. */
  seal: Sealer;
  nextId: () => string;
  signer: CantonPartySigner;
  /** The Cancore participant the party must be hosted on: release data (`FILLER_GATEWAYS`), never the backend's word. */
  participantUid: string;
  clock: Clock;
  logger: Logger;
  /** Submit attempts on a retryable refusal (`CANTON_UNAVAILABLE`, `INTERNAL`, transport); default 3. */
  submitAttempts?: number;
}

const HEX = /^0x[0-9a-f]+$/;
/** Refusals a later submit of the same operation may get past; a transport failure is one too. */
const RETRYABLE_CODES = new Set(['CANTON_UNAVAILABLE', 'INTERNAL']);
const retryable = (error: unknown): boolean => (error instanceof GatewayError ? RETRYABLE_CODES.has(error.code) : !(error instanceof CantonRefusal));
const lower = (hex: string): Hex => (hex.startsWith('0x') ? hex : `0x${hex}`).toLowerCase() as Hex;

export class CantonOperations {
  constructor(private readonly options: CantonOperationsOptions) {}

  /** The party's Ed25519 public key, as the operations name it. */
  get publicKey(): Hex {
    return lower(this.options.signer.publicKey);
  }

  /**
   * Allocates the filler party on the Cancore participant: the only operation
   * with a topology leg. The topology is checked entirely here (`verifyTopologyLeg`).
   */
  allocateParty(): Promise<SubmittedOf<'party.allocate'>> {
    return this.run('party.allocate', { publicKey: this.publicKey }, () => undefined);
  }

  /** Accepts the party's `FillerRegistryEntry` for `fillerId`, proposed by Cancore (CAN-2316). */
  acceptRegistry(fillerId: string): Promise<SubmittedOf<'registry.accept'>> {
    return this.run('registry.accept', {}, checkRegistryAccept({ fillerId, publicKey: this.publicKey }));
  }

  /** Moves the party's own holdings to another party (operator decision Yu-1): exactly what is asked, checked. */
  transfer(params: CantonOpParams['holdings.transfer']): Promise<SubmittedOf<'holdings.transfer'>> {
    return this.run('holdings.transfer', params, checkHoldingsTransfer({ params, publicKey: this.publicKey, nowMs: this.options.clock.now() }));
  }

  /** Reads the party registered for this fillerId and its registry entry. */
  party(): Promise<CantonParty> {
    return this.options.rest.getCantonParty();
  }

  holdings(): Promise<CantonHolding[]> {
    return this.options.rest.listCantonHoldings();
  }

  deliveryOrders(): Promise<CantonDeliveryOrder[]> {
    return this.options.rest.listCantonDeliveryOrders();
  }

  /**
   * Prepares `op`, checks every leg and runs `check` on the decoded
   * transactions, signs, submits. Throws `CantonRefusal` when anything is not
   * as expected — then nothing is signed or submitted.
   */
  async run<K extends CantonOp>(op: K, params: CantonOpParams[K], check: CantonOpCheck<K>): Promise<SubmittedOf<K>> {
    const { clock, logger } = this.options;
    const request = await this.options.seal<CantonPrepare>({ type: 'canton.prepare', id: this.options.nextId(), op, params } as Unsealed<CantonPrepare>);
    const prepared = (await this.options.rest.postCanton('prepare', request)).frame as unknown as PreparedOf<K>;
    const operationId = prepared.operationId;
    const refuse = (detail: string): never => {
      throw new CantonRefusal('-', `${op}: ${detail}`);
    };
    if (prepared.op !== op) refuse(`the backend prepared ${String(prepared.op)}`);
    if (prepared.re !== request.id) refuse('the answer is to another prepare');
    if (typeof operationId !== 'string' || operationId.length === 0) refuse('no operationId');
    if (!(typeof prepared.expiresAt === 'number' && prepared.expiresAt > clock.now())) refuse('the prepared operation has expired');
    if (!Array.isArray(prepared.legs) || prepared.legs.length === 0) refuse('nothing to sign');

    const transactions: CantonTransaction[] = [];
    if (op === 'party.allocate') {
      const summary = (prepared as PreparedOf<'party.allocate'>).summary;
      if (lower(String(summary?.publicKey)) !== this.publicKey) refuse('the party is for another key');
      const hosting = summary?.hosting;
      if (hosting?.participantUid !== this.options.participantUid || hosting.permission !== 'CONFIRMATION' || hosting.threshold !== 1) {
        refuse('the stated hosting is not Confirmation on the Cancore participant at threshold 1');
      }
      for (const leg of prepared.legs) {
        if (legKind(leg) !== 'topology') refuse('party.allocate signs topology legs only');
        await verifyTopologyLeg(leg as CantonLegTopology, { partyId: summary.partyId, publicKey: this.publicKey, participantUid: this.options.participantUid });
      }
    } else {
      for (const leg of prepared.legs) {
        if (legKind(leg) !== 'transaction') refuse(`${op} signs transaction legs only`);
        transactions.push(await verifyTransactionLeg(leg as CantonLegTransaction));
      }
    }
    await check(prepared, transactions);

    const signatures = [];
    for (const leg of prepared.legs) {
      const signature = lower(await this.options.signer.signHash(hexToBytes(lower(leg.hash).slice(2))));
      if (!HEX.test(signature) || signature.length !== 2 + 128) refuse('the party signer returned no 64-byte signature');
      signatures.push({ legId: leg.legId, signature });
    }
    logger.info('canton: signed', { op, operationId, legs: prepared.legs.length });
    return this.submit(op, operationId, signatures);
  }

  /** `canton.submit`, idempotent per operationId: retried on a retryable refusal while attempts last. */
  private async submit<K extends CantonOp>(op: K, operationId: string, signatures: CantonSubmit['signatures']): Promise<SubmittedOf<K>> {
    const attempts = this.options.submitAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      const message = await this.options.seal<CantonSubmit>({ type: 'canton.submit', id: this.options.nextId(), operationId, signatures });
      try {
        const submitted = (await this.options.rest.postCanton('submit', message)).frame as unknown as SubmittedOf<K>;
        if (submitted.operationId !== operationId || submitted.op !== op) throw new CantonRefusal('-', `${op}: the answer is for another operation`);
        this.options.logger.info('canton: submitted', { op, operationId, ...(submitted.updateId ? { updateId: submitted.updateId } : {}) });
        return submitted;
      } catch (error) {
        if (!retryable(error) || attempt >= attempts) throw error;
        this.options.logger.warn('canton: submit failed, trying again', { op, operationId, attempt, code: error instanceof GatewayError ? error.code : 'transport' });
      }
    }
  }
}

/** Hex of raw bytes, for signers that produce bytes. */
export const signatureHex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}` as Hex;

export interface CantonClientConfig {
  /** `wss://<filler-gateway host>/v1`; the Canton routes are REST on the same host. */
  gatewayUrl: string;
  fillerId: string;
  /** The pinned filler-gateway signer (`FILLER_GATEWAYS[env].gateway`). */
  gatewaySigner: Hex;
  /** The message key: logs in and seals every message. */
  messageSigner: QuoteSigner;
  partySigner: CantonPartySigner;
  /** The Cancore participant (release data), never taken from the backend. */
  participantUid: string;
  /** Defaults to the global `fetch`. */
  fetch?: HttpFetch;
  clock?: Clock;
  logger?: Logger;
  /** Distinguishes this process's message ids; defaults to a random UUID. */
  instanceId?: string;
}

/**
 * A Canton operations client of its own — its own REST login — for a node
 * command run outside the filler session (allocate the party, accept the
 * registry entry, move holdings).
 */
export function createCantonOperations(config: CantonClientConfig): CantonOperations {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(config.partySigner?.publicKey))) throw new FillerConfigError('partySigner.publicKey', 'expected a 32-byte Ed25519 public key, hex');
  if (typeof config.participantUid !== 'string' || !config.participantUid.includes('::')) throw new FillerConfigError('participantUid', 'expected a Canton participant uid');
  const clock = config.clock ?? systemClock;
  const logger = config.logger ?? silentLogger;
  const fetch = config.fetch ?? ((globalThis as { fetch?: HttpFetch }).fetch as HttpFetch | undefined);
  if (typeof fetch !== 'function') throw new FillerConfigError('fetch', 'no global fetch; pass an HttpFetch');
  const prefix = `${(config.instanceId ?? globalThis.crypto.randomUUID()).slice(0, 36)}:${clock.now().toString(36)}:canton`;
  let sequence = 0;
  const nextId = () => `${prefix}:${(sequence++).toString(36)}`;
  const seal = createSealer({ fillerId: config.fillerId, messageSigner: config.messageSigner, clock });
  const rest = new GatewayRest({
    gatewayUrl: config.gatewayUrl,
    fillerId: config.fillerId,
    gatewaySigner: config.gatewaySigner,
    quoteSigner: config.messageSigner,
    seal,
    fetch,
    clock,
    logger,
    nextId,
  });
  return new CantonOperations({ rest, seal, nextId, signer: config.partySigner, participantUid: config.participantUid, clock, logger });
}
