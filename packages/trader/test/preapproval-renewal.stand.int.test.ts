/**
 * CAN-2910 on the full intent stand (meta `intent-stand`, docs/runbooks/intent-stand.md): the replacement window of
 * a filler party's CNRX preapproval (operator decision Yu-1), with the stand's short term — trading runs with
 * FILLER_PREAPPROVAL_VALIDITY_SEC / FILLER_PREAPPROVAL_RENEW_WINDOW_SEC (minutes, not a year and 30 days), stated to
 * the spec in the same variables. Nothing is played: the real filler-gateway forwards, trading prepares and admits,
 * the SDK checks and the party key signs.
 *
 * The fresh stand filler (`STAND_FILLER2_*`) holds a live preapproval: a replacement is refused while it has more
 * than the window left, admitted once inside it, and the party read then names the replacement; while the two
 * overlap the party is credited directly — a transfer to it completes, it never waits as a pending instruction.
 *
 * Skipped without INTENT_STAND_ENV; with it, a missing key fails naming every missing key.
 */
import type { Hex } from '@cancore/contracts';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { CantonTransferFactory } from '../src/filler/canton/factories';
import { createCantonOperations, type CantonOperations } from '../src/filler/canton/operations';
import { GatewayError } from '../src/filler/errors';
import { createTestTypedDataSigner } from '../src/filler/testing';

const STAND = process.env.INTENT_STAND_ENV;
const REQUIRED = [
  'FILLER_GATEWAY_WS_URL', 'FILLER_GATEWAY_SIGNER', 'CANTON_PARTICIPANT_UID', 'CNRX_ADMIN_PARTY', 'CANTON_TRANSFER_FACTORIES_JSON',
  'STAND_FILLER_ID', 'STAND_FILLER_MESSAGE_KEY', 'STAND_FILLER_CANTON_PARTY', 'STAND_FILLER_CANTON_PARTY_KEY',
  'STAND_FILLER2_ID', 'STAND_FILLER2_MESSAGE_KEY', 'STAND_FILLER2_CANTON_PARTY', 'STAND_FILLER2_CANTON_PARTY_KEY',
  'FILLER_PREAPPROVAL_VALIDITY_SEC', 'FILLER_PREAPPROVAL_RENEW_WINDOW_SEC',
] as const;
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`intent-stand env: ${name} is not set`);
  return value;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Canton operations of one stand filler, over its own REST login to the stand's filler-gateway. */
function operations(prefix: 'STAND_FILLER' | 'STAND_FILLER2'): CantonOperations {
  const seed = hexToBytes(env(`${prefix}_CANTON_PARTY_KEY`).replace(/^0x/, ''));
  return createCantonOperations({
    gatewayUrl: env('FILLER_GATEWAY_WS_URL'),
    fillerId: env(`${prefix}_ID`),
    gatewaySigner: env('FILLER_GATEWAY_SIGNER') as Hex,
    messageSigner: createTestTypedDataSigner(env(`${prefix}_MESSAGE_KEY`) as Hex),
    partySigner: { publicKey: `0x${bytesToHex(ed25519.getPublicKey(seed))}` as Hex, signHash: async (hash) => `0x${bytesToHex(ed25519.sign(hash, seed))}` as Hex },
    participantUid: env('CANTON_PARTICIPANT_UID'),
    registries: JSON.parse(env('CANTON_TRANSFER_FACTORIES_JSON')) as Record<string, CantonTransferFactory[]>,
  });
}

describe('CAN-2910: the replacement window of a filler party preapproval on the full intent stand', () => {
  if (!STAND) {
    test.skip('TC-SDK-2910-STAND: needs the intent stand (INTENT_STAND_ENV)', () => undefined);
    return;
  }
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    test('TC-SDK-2910-STAND: the intent-stand env is complete', () => {
      throw new Error(`INTENT_STAND_ENV is set but the stand env lacks: ${missing.join(', ')}`);
    });
    return;
  }

  test('TC-SDK-2910-STAND-01: refused while more than the window is left, replaced inside it, and the party is credited directly while the two overlap', async () => {
    const ops = operations('STAND_FILLER2');
    const admin = env('CNRX_ADMIN_PARTY');
    const windowSec = Number(env('FILLER_PREAPPROVAL_RENEW_WINDOW_SEC'));
    const liveOf = async () => ((await ops.party()).preapprovals ?? []).find((p) => p.admin === admin);

    // A live preapproval to replace: the one an earlier spec made, or a fresh one.
    let current = await liveOf();
    if (!current) {
      await ops.createPreapproval(admin);
      current = await liveOf();
    }
    expect(current).toBeDefined();
    const old = current!;

    // More than the window left: Cancore refuses, naming the live one.
    if (Number(old.executeBefore) * 1000 - Date.now() > windowSec * 1000 + 5_000) {
      const refused = await ops.createPreapproval(admin).then(() => undefined, (e: unknown) => e);
      expect(refused).toBeInstanceOf(GatewayError);
      expect((refused as GatewayError).code).toBe('BAD_REQUEST');
      expect((refused as GatewayError).message).toContain(old.contractId);
    }

    // Inside the window: the replacement is admitted beside the old one.
    const waitMs = Number(old.executeBefore) * 1000 - windowSec * 1000 - Date.now() + 2_000;
    if (waitMs > 0) await sleep(waitMs);
    expect(Number(old.executeBefore) * 1000).toBeGreaterThan(Date.now());
    const replaced = await ops.createPreapproval(admin);
    expect(replaced.result.preapprovalCid).not.toBe(old.contractId);

    // The party read names the replacement: the live one that lapses last.
    const now = await liveOf();
    expect(now).toEqual(expect.objectContaining({ admin, contractId: replaced.result.preapprovalCid }));
    expect(Number(now!.executeBefore)).toBeGreaterThan(Number(old.executeBefore));

    // While the two overlap the party is credited directly: a transfer to it completes, nothing waits for it.
    const sent = await operations('STAND_FILLER').transfer({ asset: { admin, id: 'CNRX' }, amount: '1.0', toParty: env('STAND_FILLER2_CANTON_PARTY') });
    expect(sent.result.outcome).toBe('COMPLETED');
    expect(sent.result.transferInstructionCid).toBeUndefined();
  }, 300_000);
});
