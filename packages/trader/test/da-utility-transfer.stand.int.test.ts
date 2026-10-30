/**
 * CAN-2931, spike Д0 on the full intent stand: the shape of a CBTC transfer through the DA Utilities registry,
 * as the node would have to check it before its party key signs one (`delivery.fill`, `holdings.transfer`). The
 * stand runs DA's own registry DARs (meta `dars/utility`) behind the local registry stand-in (registry-shim,
 * meta docs/intents/local-stand.md step 3); `registry-seed` hands CBTC to the genesis parties.
 *
 * No transfer is committed: the transfer factory and its context come from the stand's registry, the
 * `TransferFactory_Transfer` is only prepared (interactive submission), and the decoded transaction — every
 * node's template, choice, signatories, stakeholders, and the created arguments — is printed between
 * `CAN-2931-DA-TRANSFER-BEGIN` / `-END` for the SDK's pin of the registry (`CantonTransferFactory`).
 * STAND-01 is a receiver without a preapproval (an offer); STAND-02 first gives the stand user's party a
 * utility preapproval of the stand's registrar through the backend — the one write, on the stand only — so the
 * transfer to it is direct, as a delivery must be.
 *
 * Skipped without INTENT_STAND_ENV; with it, a missing key fails naming every missing key.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodePreparedTransaction } from '../src/filler/canton/hashing';
import { checkTransferExercise } from '../src/filler/canton/checks';
import { CANTON_TRANSFER_FACTORIES } from '../src/filler/canton/factories';
import { transactionView, type DamlValue, type ExerciseNode } from '../src/filler/canton/transaction';
import { activeContracts, cantonToken, env, ledger } from './stand/canton-ledger';

const STAND = process.env.INTENT_STAND_ENV;
const REQUIRED = [
  'CANTON_JSON_API_URL', 'CANTON_TOKEN_URL', 'CANTON_CLIENT_ID', 'CANTON_CLIENT_SECRET', 'CANTON_SYNCHRONIZER_ID',
  'GATEWAY_URL', 'STAND_OWNER_PARTY', 'STAND_USER_TOKEN_URL', 'STAND_USER_CLIENT_ID', 'STAND_USER_CLIENT_SECRET', 'STAND_USER_NAME', 'STAND_USER_PASSWORD',
] as const;

const HOLDING_V1 = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
const TRANSFER_FACTORY = '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';
const UTILITY_PREAPPROVAL = '#utility-registry-app-v0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval';
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

interface Spike {
  bootstrap: Bootstrap;
  genesis: Genesis;
  admin: string;
  token: string;
  userId: string;
}

async function spike(): Promise<Spike> {
  const bootstrap = readJson<Bootstrap>('registry-bootstrap.json');
  const token = await cantonToken();
  const { user } = await ledger<{ user: { id: string } }>('/v2/authenticated-user', token);
  return { bootstrap, genesis: readJson<Genesis>('genesis.json'), admin: bootstrap.registryParty, token, userId: user.id };
}

/**
 * One `TransferFactory_Transfer` of CBTC to `receiverName`, prepared and decoded — never submitted — from the
 * first genesis party holding unlocked CBTC: the seed's balances name `<instrument>/<party>`, and any party may
 * hold CBTC after the handout, so all are tried. Printed between the spike's markers under `label`.
 */
type Prepared = { transferKind: string; tx: ReturnType<typeof transactionView>; sender: string; receiver: string; amount: string; inputs: string[]; executeBefore: string };

async function prepareTransfer(s: Spike, receiverName: string, label: string): Promise<Prepared> {
  const { bootstrap, genesis, admin, token } = s;
  const seeded = Object.keys(bootstrap.balances ?? {}).filter((k) => k.toUpperCase().startsWith(`${INSTRUMENT}/`)).map((k) => k.slice(INSTRUMENT.length + 1));
  const holders = [...new Set([...seeded, ...Object.keys(genesis.parties)])];
  const tried: string[] = [];
  for (const senderName of holders.filter((n) => n !== receiverName)) {
    const sender = genesis.parties[senderName];
    const receiver = genesis.parties[receiverName];
    if (!sender || !receiver) continue;
    const inputs = await holdings(sender, admin, token).catch((e: Error) => (tried.push(`${senderName}: ${e.message.slice(0, 200)}`), [] as string[]));
    if (inputs.length === 0) { tried.push(`${senderName}: no unlocked ${INSTRUMENT}`); continue; }
    const executeBeforeSec = Math.floor(Date.now() / 1000) + 3600;
    const transfer = {
      sender, receiver, amount: '0.0001', instrumentId: { admin, id: INSTRUMENT },
      requestedAt: new Date().toISOString(), executeBefore: new Date(executeBeforeSec * 1000).toISOString(), inputHoldingCids: inputs.slice(0, 1), meta: { values: {} },
    };
    const shim = (process.env.REGISTRY_SHIM_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
    const factoryResponse = await fetch(`${shim}/${encodeURIComponent(admin)}/registry/transfer-instruction/v1/transfer-factory`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choiceArguments: { expectedAdmin: admin, transfer, extraArgs: { context: { values: {} }, meta: { values: {} } } }, excludeDebugFields: true }),
    });
    if (!factoryResponse.ok) { tried.push(`${senderName}: factory ${factoryResponse.status} ${(await factoryResponse.text()).slice(0, 300)}`); continue; }
    const factory = (await factoryResponse.json()) as Factory;
    const prepared = await ledger<{ preparedTransaction: string }>('/v2/interactive-submission/prepare', token, {
      userId: s.userId, commandId: `can-2931-spike-${Date.now()}`, actAs: [sender], readAs: [], synchronizerId: env('CANTON_SYNCHRONIZER_ID'), packageIdSelectionPreference: [],
      commands: [{ ExerciseCommand: { templateId: TRANSFER_FACTORY, contractId: factory.factoryId, choice: 'TransferFactory_Transfer', choiceArgument: { expectedAdmin: admin, transfer, extraArgs: { context: factory.choiceContext.choiceContextData, meta: { values: {} } } } } }],
      disclosedContracts: factory.choiceContext.disclosedContracts,
    }).catch((e: Error) => (tried.push(`${senderName}: prepare ${e.message.slice(0, 400)}`), null));
    if (!prepared) continue;

    const tx = transactionView(decodePreparedTransaction(prepared.preparedTransaction));
    const report = {
      label, admin, sender, receiver, transferKind: factory.transferKind, factoryId: factory.factoryId,
      contextKeys: Object.keys(factory.choiceContext.choiceContextData.values),
      disclosed: factory.choiceContext.disclosedContracts.map((d) => d.templateId),
      roots: tx.roots,
      nodes: Object.values(tx.nodes).map((n) => n.kind === 'rollback' ? n : {
        nodeId: n.nodeId, kind: n.kind, templateId: n.templateId, signatories: n.signatories, stakeholders: n.stakeholders,
        ...(n.kind === 'exercise' ? { choice: n.choice, interfaceId: n.interfaceId, consuming: n.consuming, actingParties: n.actingParties, children: n.children, contractId: n.contractId } : {}),
        ...(n.kind === 'create' ? { contractId: n.contractId, fields: fieldsOf(n.argument), argument: n.argument } : {}),
        ...(n.kind === 'fetch' ? { contractId: n.contractId } : {}),
      }),
      inputContracts: tx.inputContracts.map((c) => ({ contractId: c.contractId, templateId: c.templateId, stakeholders: c.stakeholders, fields: fieldsOf(c.argument), argument: c.argument })),
    };
    console.log(`CAN-2931-DA-TRANSFER-BEGIN\n${JSON.stringify(report, null, 2)}\nCAN-2931-DA-TRANSFER-END`);
    return { transferKind: factory.transferKind, tx, sender, receiver, amount: transfer.amount, inputs: transfer.inputHoldingCids, executeBefore: String(executeBeforeSec) };
  }
  throw new Error(`no CBTC holder of ${admin} could prepare a transfer to ${receiverName}:\n${tried.join('\n')}`);
}

(STAND ? describe : describe.skip)('CAN-2931 spike Д0: a CBTC transfer through the DA Utilities registry on the intent stand', () => {
  it('env: every key the spike reads is set', () => {
    expect(REQUIRED.filter((k) => !process.env[k])).toEqual([]);
  });

  it('TC-CAN-2931-STAND-01: TransferFactory_Transfer of CBTC to a receiver without a preapproval — an offer, nothing committed', async () => {
    const { tx } = await prepareTransfer(await spike(), 'alice', 'offer');
    expect(tx.roots).toHaveLength(1);
    expect(tx.nodes[tx.roots[0] as string]).toMatchObject({ kind: 'exercise', choice: 'TransferFactory_Transfer' });
  }, 180_000);

  it('TC-CAN-2931-STAND-02: with the receiver’s utility preapproval of the registrar the transfer is direct — the shape a delivery signs', async () => {
    const s = await spike();
    const owner = env('STAND_OWNER_PARTY');
    const receiverName = Object.entries(s.genesis.parties).find(([, p]) => p === owner)?.[0];
    if (!receiverName) throw new Error(`STAND_OWNER_PARTY ${owner} is no genesis party`);
    // The stand user's own preapproval, made the way a user makes it (backend /tokens/utility-preapprovals): the
    // participant's validator user may act as no genesis party. Its operator is the stand's registry party.
    const login = await fetch(env('STAND_USER_TOKEN_URL'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: env('STAND_USER_CLIENT_ID'), client_secret: env('STAND_USER_CLIENT_SECRET'), username: env('STAND_USER_NAME'), password: env('STAND_USER_PASSWORD') }),
    });
    const bearer = ((await login.json()) as { access_token: string }).access_token;
    const setup = await fetch(`${env('GATEWAY_URL')}/tokens/utility-preapprovals/setup`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ tokenId: INSTRUMENT }),
    });
    const answer = (await setup.json()) as { success?: boolean };
    if (!answer.success) throw new Error(`utility preapproval setup of ${owner}: ${setup.status} ${JSON.stringify(answer).slice(0, 300)}`);

    // What registry-shim's find_preapproval sees: the registry party's utility preapprovals of this receiver.
    const seen = await activeContracts(s.admin, { TemplateFilter: { value: { templateId: UTILITY_PREAPPROVAL, includeCreatedEventBlob: false } } }, s.token);
    console.log(`CAN-2931-DA-PREAPPROVALS ${JSON.stringify({ admin: s.admin, receiver: owner, preapprovals: seen.map((e) => e.createArgument) })}`);

    const p = await prepareTransfer(s, receiverName, 'direct');
    expect(p.transferKind).toBe('direct');
    const root = p.tx.nodes[p.tx.roots[0] as string] as ExerciseNode;
    expect(root).toMatchObject({ kind: 'exercise', choice: 'TransferFactory_Transfer' });
    // The node's own check of a delivery (`completedOnly`) over the registry's real direct transfer: the pin of
    // DA Utilities is what the registry builds, with the stand's registrar as the CBTC admin.
    const pin = CANTON_TRANSFER_FACTORIES['cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff'] ?? [];
    expect(() => checkTransferExercise(p.tx, root, {
      sender: p.sender, asked: { asset: { admin: s.admin, id: INSTRUMENT }, amount: p.amount, toParty: p.receiver }, stated: p.inputs,
      executeBefore: p.executeBefore, factories: { [s.admin]: pin }, completedOnly: true,
    })).not.toThrow();
  }, 180_000);
});
