/**
 * CAN-2931, spike Д0 on the full intent stand: the shape of a CBTC transfer through the DA Utilities registry,
 * as the node would have to check it before its party key signs one (`delivery.fill`, `holdings.transfer`). The
 * stand runs DA's own registry DARs (meta `dars/utility`) behind the local registry stand-in (registry-shim,
 * meta docs/intents/local-stand.md step 3); `registry-seed` hands CBTC to the genesis parties.
 *
 * Nothing is committed: the transfer factory and its context come from the stand's registry, the
 * `TransferFactory_Transfer` is only prepared (interactive submission), and the decoded transaction — every
 * node's template, choice, signatories, stakeholders, and the created arguments' fields — is printed between
 * `CAN-2931-DA-TRANSFER-BEGIN` / `-END` for the SDK's pin of the registry (`CantonTransferFactory`).
 *
 * Skipped without INTENT_STAND_ENV; with it, a missing key fails naming every missing key.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodePreparedTransaction } from '../src/filler/canton/hashing';
import { transactionView, type DamlValue } from '../src/filler/canton/transaction';
import { activeContracts, cantonToken, env, ledger } from './stand/canton-ledger';

const STAND = process.env.INTENT_STAND_ENV;
const REQUIRED = ['CANTON_JSON_API_URL', 'CANTON_TOKEN_URL', 'CANTON_CLIENT_ID', 'CANTON_CLIENT_SECRET', 'CANTON_SYNCHRONIZER_ID'] as const;

const HOLDING_V1 = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
const TRANSFER_FACTORY = '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';
const INSTRUMENT = 'CBTC';

type Bootstrap = { registryParty: string; balances: Record<string, string> };
type Genesis = { parties: Record<string, string>; nodes?: Record<string, string> };
type Disclosed = { templateId: string; contractId: string; createdEventBlob: string; synchronizerId: string };
type Factory = { factoryId: string; transferKind: string; choiceContext: { choiceContextData: { values: Record<string, unknown> }; disclosedContracts: Disclosed[] } };

const out = () => dirname(STAND as string);
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(out(), name), 'utf8')) as T;

/** The unlocked CBTC holdings of `party` under `admin`, read through the token standard's holding interface. */
async function holdings(party: string, admin: string, token: string): Promise<string[]> {
  type View = { owner?: string; instrumentId?: { admin?: string; id?: string }; lock?: unknown };
  const events = await activeContracts(party, { InterfaceFilter: { value: { interfaceId: HOLDING_V1, includeInterfaceView: true, includeCreatedEventBlob: false } } }, token);
  return events.flatMap((event) => {
    const view = event.interfaceViews?.[0]?.viewValue as View | undefined;
    return view?.owner === party && view.instrumentId?.admin === admin && view.instrumentId?.id === INSTRUMENT && !view.lock ? [event.contractId] : [];
  });
}

const fieldsOf = (v: DamlValue): string[] => (v.t === 'record' ? Object.keys(v.v) : [v.t]);

(STAND ? describe : describe.skip)('CAN-2931 spike Д0: a CBTC transfer through the DA Utilities registry on the intent stand', () => {
  it('env: every key the spike reads is set', () => {
    expect(REQUIRED.filter((k) => !process.env[k])).toEqual([]);
  });

  it('TC-CAN-2931-STAND-01: TransferFactory_Transfer of CBTC prepared, decoded and printed — nothing committed', async () => {
    const bootstrap = readJson<Bootstrap>('registry-bootstrap.json');
    const genesis = readJson<Genesis>('genesis.json');
    const admin = bootstrap.registryParty;
    // The seed's balances name `<instrument>/<party>`; any genesis party may hold CBTC after the handout, so all are tried.
    const seeded = Object.keys(bootstrap.balances ?? {}).filter((k) => k.toUpperCase().startsWith(`${INSTRUMENT}/`)).map((k) => k.slice(INSTRUMENT.length + 1));
    const holders = [...new Set([...seeded, ...Object.keys(genesis.parties)])];
    const receiverName = 'alice';
    const token = await cantonToken();
    const { user } = await ledger<{ user: { id: string } }>('/v2/authenticated-user', token);

    const tried: string[] = [];
    for (const senderName of holders.filter((n) => n !== receiverName)) {
      const sender = genesis.parties[senderName];
      const receiver = genesis.parties[receiverName as string];
      if (!sender || !receiver) continue;
      const inputs = await holdings(sender, admin, token).catch((e: Error) => (tried.push(`${senderName}: ${e.message.slice(0, 200)}`), [] as string[]));
      if (inputs.length === 0) { tried.push(`${senderName}: no unlocked ${INSTRUMENT}`); continue; }
      const transfer = {
        sender, receiver, amount: '0.0001', instrumentId: { admin, id: INSTRUMENT },
        requestedAt: new Date().toISOString(), executeBefore: new Date(Date.now() + 3_600_000).toISOString(), inputHoldingCids: inputs.slice(0, 1), meta: { values: {} },
      };
      const shim = (process.env.REGISTRY_SHIM_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
      const factoryResponse = await fetch(`${shim}/${encodeURIComponent(admin)}/registry/transfer-instruction/v1/transfer-factory`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer, extraArgs: { context: { values: {} }, meta: { values: {} } } }, excludeDebugFields: true }),
      });
      if (!factoryResponse.ok) { tried.push(`${senderName}: factory ${factoryResponse.status} ${(await factoryResponse.text()).slice(0, 300)}`); continue; }
      const factory = (await factoryResponse.json()) as Factory;
      const prepared = await ledger<{ preparedTransaction: string }>('/v2/interactive-submission/prepare', token, {
        userId: user.id, commandId: `can-2931-spike-${Date.now()}`, actAs: [sender], readAs: [], synchronizerId: env('CANTON_SYNCHRONIZER_ID'), packageIdSelectionPreference: [],
        commands: [{ ExerciseCommand: { templateId: TRANSFER_FACTORY, contractId: factory.factoryId, choice: 'TransferFactory_Transfer', choiceArgument: { expectedAdmin: admin, transfer, extraArgs: { context: factory.choiceContext.choiceContextData, meta: { values: {} } } } } }],
        disclosedContracts: factory.choiceContext.disclosedContracts,
      }).catch((e: Error) => (tried.push(`${senderName}: prepare ${e.message.slice(0, 400)}`), null));
      if (!prepared) continue;

      const tx = transactionView(decodePreparedTransaction(prepared.preparedTransaction));
      const report = {
        admin, sender, receiver, transferKind: factory.transferKind, factoryId: factory.factoryId,
        contextKeys: Object.keys(factory.choiceContext.choiceContextData.values),
        disclosed: factory.choiceContext.disclosedContracts.map((d) => d.templateId),
        roots: tx.roots,
        nodes: Object.values(tx.nodes).map((n) => n.kind === 'rollback' ? n : {
          nodeId: n.nodeId, kind: n.kind, templateId: n.templateId, signatories: n.signatories, stakeholders: n.stakeholders,
          ...(n.kind === 'exercise' ? { choice: n.choice, interfaceId: n.interfaceId, consuming: n.consuming, actingParties: n.actingParties, children: n.children, contractId: n.contractId } : {}),
          ...(n.kind === 'create' ? { contractId: n.contractId, fields: fieldsOf(n.argument) } : {}),
        }),
        inputContracts: tx.inputContracts.map((c) => ({ contractId: c.contractId, templateId: c.templateId, stakeholders: c.stakeholders, fields: fieldsOf(c.argument) })),
      };
      console.log(`CAN-2931-DA-TRANSFER-BEGIN\n${JSON.stringify(report, null, 2)}\nCAN-2931-DA-TRANSFER-END`);
      expect(tx.roots).toHaveLength(1);
      expect(tx.nodes[tx.roots[0] as string]).toMatchObject({ kind: 'exercise', choice: 'TransferFactory_Transfer' });
      return;
    }
    throw new Error(`no CBTC holder of ${admin} could prepare a transfer to ${receiverName} (seeded: ${seeded.join(', ') || 'none'}; balances: ${JSON.stringify(bootstrap.balances ?? {}).slice(0, 500)}):\n${tried.join('\n')}`);
  }, 180_000);
});
