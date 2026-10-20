/**
 * CAN-2904 on the full intent stand (meta `intent-stand`, docs/runbooks/intent-stand.md): the filler's party
 * creates its own CNRX transfer preapproval through `preapproval.create` — the real filler-gateway forwards, trading
 * prepares and submits, the SDK checks the decoded create and signs it with the party key. Nothing is played.
 *
 * Two stand fillers: the provisioned one (`STAND_FILLER_*`, its preapproval already live) shows the party read
 * listing it and a second create refused, naming it; a fresh one (`STAND_FILLER2_*`, an external party with no
 * preapproval) creates it, reads it back, and is refused the next time.
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
] as const;
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`intent-stand env: ${name} is not set`);
  return value;
};

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

const refusal = async (run: Promise<unknown>): Promise<GatewayError> => {
  const error = await run.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof GatewayError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
};

describe('CAN-2904: preapproval.create on the full intent stand', () => {
  if (!STAND) {
    test.skip('TC-SDK-2904-STAND: needs the intent stand (INTENT_STAND_ENV)', () => undefined);
    return;
  }
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    test('TC-SDK-2904-STAND: the intent-stand env is complete', () => {
      throw new Error(`INTENT_STAND_ENV is set but the stand env lacks: ${missing.join(', ')}`);
    });
    return;
  }

  test('TC-SDK-2904-STAND-01: a party with a live preapproval reads it, and a second create is refused naming it', async () => {
    const ops = operations('STAND_FILLER');
    const admin = env('CNRX_ADMIN_PARTY');
    const party = await ops.party();
    expect(party.party).toBe(env('STAND_FILLER_CANTON_PARTY'));
    const live = (party.preapprovals ?? []).find((p) => p.admin === admin);
    expect(live).toBeDefined();
    expect(Number(live!.executeBefore) * 1000).toBeGreaterThan(Date.now());

    const error = await refusal(ops.createPreapproval(admin));
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toContain(live!.contractId);
  }, 120_000);

  test('TC-SDK-2904-STAND-02: a party without one creates it — checked and signed by the SDK — reads it back, and is refused the next time', async () => {
    const ops = operations('STAND_FILLER2');
    const admin = env('CNRX_ADMIN_PARTY');
    const before = await ops.party();
    expect(before.party).toBe(env('STAND_FILLER2_CANTON_PARTY'));
    expect((before.preapprovals ?? []).filter((p) => p.admin === admin)).toEqual([]);

    const submitted = await ops.createPreapproval(admin);
    expect(submitted).toMatchObject({ op: 'preapproval.create', result: { preapprovalCid: expect.any(String) } });

    const after = await ops.party();
    expect((after.preapprovals ?? []).filter((p) => p.admin === admin)).toEqual([expect.objectContaining({ admin, contractId: submitted.result.preapprovalCid })]);

    const again = await refusal(ops.createPreapproval(admin));
    expect(again.code).toBe('BAD_REQUEST');
    expect(again.message).toContain(submitted.result.preapprovalCid);
  }, 180_000);
});
