import { type DamlTransaction_Node, PreparedTransaction, type Value } from '@canton-network/core-ledger-proto';
import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import { describe, expect, jest, test } from '@jest/globals';
import { signLegs, signPreparedHashBase64, signPreparedTransaction, UnexpectedLegError, type HashSigner } from '../operations';
import { INTENT_PACKAGE_IDS, IntentTransactionRefusedError, type IntentRoot, type IntentSigningPolicy } from './intentPolicy';
import { verifyPreparedTransaction } from './prepared';
import { isRegistryFactory, REGISTRY_PACKAGES } from './registry';

const INTENT_PKG = INTENT_PACKAGE_IDS[0] as string;
/** cancore-intent 0.5.1 (canton-contracts `external-test-dars/cancore-intent-0.5.1.dar`): still an SCU predecessor of 0.6.2. */
const INTENT_0_5_1 = 'cc52de44b338f20f0438cc0cb82d877ecb2128dcd1dcd50145b9e697a5612626';
const OWNER = 'alice::1220' + '0a'.repeat(32);
const OPERATOR = 'cancore-operator::1220' + '0b'.repeat(32);
const FILLER = 'filler::1220' + '0c'.repeat(32);
const ROGUE_PKG = 'ee'.repeat(32);

interface Registry {
  name: string;
  admin: string;
  factory: string;
  factorySignatories: string[];
  holding: string;
}

const DSO = 'DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a';
const CBTC = 'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff';
const CNRX = 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b';
const DA_OPERATOR = 'auth0_007c65f857f1c3d599cb6df73775::1220d2d732d042c281cee80f483ab80f3cbaa4782860ed5f4dc228ab03dedd2ee8f9';
const CNRX_GUARDIAN = 'cnrx-guardian::1220' + '0d'.repeat(32);

const REGISTRIES: Registry[] = [
  {
    name: 'Amulet (CC)',
    admin: DSO,
    factory: '17b6f7c18efec9022dde39a19039783c68490a722e8a5088b22ee034678171a2:Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules',
    factorySignatories: [DSO],
    holding: '17b6f7c18efec9022dde39a19039783c68490a722e8a5088b22ee034678171a2:Splice.Amulet:Amulet',
  },
  {
    name: 'DA Utilities (CBTC)',
    admin: CBTC,
    factory: '1eddd268bdd50d6e262722bea799c9455da032b3f94489e589975151b274b8c0:Utility.Registry.App.V0.Service.AllocationFactory:AllocationFactory',
    factorySignatories: [DA_OPERATOR, CBTC],
    holding: '415a1ec96a9e2839453e9aa1c5c71b6511c008c79511cb6f873e0b7393fe3b92:Utility.Registry.Holding.V0.Holding:Holding',
  },
  {
    name: 'cnrx-registry (CNRX)',
    admin: CNRX,
    factory: '0cc44c28f323b455c1875e85fd7a1ad7732ad2a34ed8dd1550cb79dead750bba:Cnrx.Rules:CnrxRules',
    factorySignatories: [CNRX, CNRX_GUARDIAN],
    holding: '0cc44c28f323b455c1875e85fd7a1ad7732ad2a34ed8dd1550cb79dead750bba:Cnrx.Holding:CnrxHolding',
  },
];
const [AMULET] = REGISTRIES as [Registry, ...Registry[]];

const unit: Value = { sum: { oneofKind: 'unit', unit: {} } };
const identifier = (templateId: string) => {
  const [packageId = '', moduleName = '', entityName = ''] = templateId.split(':');
  return { packageId, moduleName, entityName };
};
const cid = (n: number) => `00${n.toString(16).padStart(2, '0')}${'ab'.repeat(32)}`;

interface ExerciseSpec {
  kind: 'exercise';
  template: string;
  choice: string;
  actors: string[];
  signatories: string[];
  interface?: string;
  packageName?: string;
  children?: NodeSpec[];
}
interface CreateSpec {
  kind: 'create';
  template: string;
  signatories: string[];
  packageName?: string;
}
interface FetchSpec {
  kind: 'fetch';
  template: string;
  signatories: string[];
}
type NodeSpec = ExerciseSpec | CreateSpec | FetchSpec;

const intent = (template: string) => `${INTENT_PKG}:${template}`;
const ALLOCATION_FACTORY = `${'c1'.repeat(32)}:Splice.Api.Token.AllocationInstructionV2:AllocationFactory`;
const SETTLEMENT_FACTORY = `${'c2'.repeat(32)}:Splice.Api.Token.AllocationV2:SettlementFactory`;

function registryCalls(r: Registry, factory = r.factory, factorySignatories = r.factorySignatories): NodeSpec[] {
  return [
    { kind: 'exercise', template: factory, interface: SETTLEMENT_FACTORY, choice: 'SettlementFactory_PublicFetch', actors: [OWNER], signatories: factorySignatories, packageName: 'registry' },
    {
      kind: 'exercise',
      template: factory,
      interface: ALLOCATION_FACTORY,
      choice: 'AllocationFactory_Allocate',
      actors: [OWNER],
      signatories: factorySignatories,
      packageName: 'registry',
      children: [
        { kind: 'exercise', template: r.holding, choice: 'Archive', actors: [OWNER, r.admin], signatories: [OWNER, r.admin], packageName: 'registry' },
        { kind: 'create', template: r.holding, signatories: [OWNER, r.admin], packageName: 'registry' },
      ],
    },
  ];
}

function root(kind: IntentRoot, children: NodeSpec[]): ExerciseSpec {
  return kind === 'open'
    ? { kind: 'exercise', template: intent('Intent.SwapIntent:IntentFactory'), choice: 'IntentFactory_Open', actors: [OWNER], signatories: [OPERATOR], children }
    : { kind: 'exercise', template: intent('Intent.SwapIntent:SwapIntent'), choice: 'SwapIntent_RenewSettlementFactory', actors: [OWNER], signatories: [OWNER, OPERATOR], children };
}

function honest(kind: IntentRoot, r: Registry, calls = registryCalls(r)): ExerciseSpec {
  const pin: NodeSpec = { kind: 'fetch', template: intent('Intent.RegistryFactoryPin:RegistryFactoryPin'), signatories: [OPERATOR] };
  const swapIntent: NodeSpec = { kind: 'create', template: intent('Intent.SwapIntent:SwapIntent'), signatories: [OWNER, OPERATOR] };
  if (kind === 'renewSettlementFactory') return root(kind, [pin, calls[0] as NodeSpec, swapIntent]);
  return root(kind, [
    pin,
    { kind: 'exercise', template: intent('Intent.FillerRegistry:FillerRegistryEntry'), choice: 'FillerRegistryEntry_PublicFetch', actors: [OWNER], signatories: [OPERATOR, FILLER] },
    ...calls,
    swapIntent,
    {
      kind: 'exercise',
      template: intent('Intent.SwapIntent:IntentBook'),
      choice: 'IntentBook_Record',
      actors: [OPERATOR],
      signatories: [OPERATOR, CNRX_GUARDIAN],
      children: [{ kind: 'create', template: intent('Intent.SwapIntent:IntentBook'), signatories: [OPERATOR, CNRX_GUARDIAN] }],
    },
  ]);
}

function build(spec: NodeSpec, nodes: DamlTransaction_Node[], seeds: Array<{ nodeId: number; seed: Uint8Array }>): string {
  const nodeId = String(nodes.length);
  const slot = nodes.length;
  nodes.push(undefined as never);
  const common = { lfVersion: '2.1', contractId: cid(slot), packageName: spec.kind !== 'fetch' && spec.packageName ? spec.packageName : 'cancore-intent', templateId: identifier(spec.template), signatories: spec.signatories, stakeholders: spec.signatories };
  let nodeType: Extract<DamlTransaction_Node['versionedNode'], { oneofKind: 'v1' }>['v1']['nodeType'];
  if (spec.kind === 'create') nodeType = { oneofKind: 'create', create: { ...common, argument: unit } };
  else if (spec.kind === 'fetch') nodeType = { oneofKind: 'fetch', fetch: { ...common, actingParties: [OWNER] } };
  else {
    seeds.push({ nodeId: slot, seed: new Uint8Array(32).fill(slot + 1) });
    const children = (spec.children ?? []).map((child) => build(child, nodes, seeds));
    nodeType = {
      oneofKind: 'exercise',
      exercise: { ...common, ...(spec.interface ? { interfaceId: identifier(spec.interface) } : {}), actingParties: spec.actors, choiceId: spec.choice, chosenValue: unit, consuming: false, choiceObservers: [], children },
    };
  }
  nodes[slot] = { nodeId, versionedNode: { oneofKind: 'v1', v1: { nodeType } } };
  return nodeId;
}

async function prepared(spec: ExerciseSpec, actAs = [OWNER]): Promise<{ tx: string; hash: string }> {
  const nodes: DamlTransaction_Node[] = [];
  const seeds: Array<{ nodeId: number; seed: Uint8Array }> = [];
  const rootId = build(spec, nodes, seeds);
  const message = PreparedTransaction.create({
    transaction: { version: '2.1', roots: [rootId], nodes, nodeSeeds: seeds },
    metadata: {
      submitterInfo: { actAs, commandId: 'can-3340-test' },
      synchronizerId: 'global-domain::1220dso',
      mediatorGroup: 0,
      transactionUuid: '00000000-0000-4000-8000-000000003340',
      preparationTime: 1000000000000000n,
      inputContracts: [],
      globalKeyMapping: [],
    },
  });
  const tx = Buffer.from(PreparedTransaction.toBinary(message)).toString('base64');
  return { tx, hash: Buffer.from(await hashPreparedTransaction(tx, 'hex'), 'hex').toString('base64') };
}

const policy = (r: Registry, over: Partial<IntentSigningPolicy> = {}): IntentSigningPolicy => ({ owner: OWNER, admin: r.admin, ...over });

function signer(): HashSigner & { signPreparedHash: jest.Mock<(hash: string) => Promise<string>> } {
  return { signMessage: jest.fn(async () => 'never'), signPreparedHash: jest.fn(async (hash: string) => `sig:${hash}`) };
}

async function refusal(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof IntentTransactionRefusedError) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the owner signs an intent root from its prepared transaction (CAN-3340)', () => {
  const ROOTS: IntentRoot[] = ['open', 'renewSettlementFactory'];
  test.each(REGISTRIES.flatMap((r) => ROOTS.map((kind) => [r.name, kind, r] as const)))('TC-SDK-3340-01: an honest %s %s is signed', async (_name, kind, r) => {
    const { tx, hash } = await prepared(honest(kind, r));
    const key = signer();
    await expect(signPreparedTransaction(key, tx, hash, policy(r))).resolves.toBe(`sig:${hash}`);
    expect(key.signPreparedHash).toHaveBeenCalledWith(hash);
    expect(verifyPreparedTransaction(tx, hash, policy(r))).toBe(kind);
  });

  test.each(['open', 'renewSettlementFactory'] as const)('TC-SDK-3340-02: a %s through a factory the admin does not sign, of no registry package, is refused', async (kind) => {
    const rogue = `${ROGUE_PKG}:Evil.Factory:EvilSettlementFactory`;
    const { tx, hash } = await prepared(honest(kind, AMULET, registryCalls(AMULET, rogue, [OPERATOR])));
    const key = signer();
    expect(await refusal(() => signPreparedTransaction(key, tx, hash, policy(AMULET)))).toMatch(/not a factory of the registry/);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test('TC-SDK-3340-03: a hash that is not the hash of the prepared transaction is refused', async () => {
    const { tx } = await prepared(honest('open', AMULET));
    const other = await prepared(honest('renewSettlementFactory', AMULET));
    expect(await refusal(() => signPreparedTransaction(signer(), tx, other.hash, policy(AMULET)))).toMatch(/hash is not the hash/);
  });

  test('TC-SDK-3340-04: an extra exercise with the owner among its actors is refused', async () => {
    const extra: NodeSpec = { kind: 'exercise', template: `${ROGUE_PKG}:Evil.Drain:Drain`, choice: 'Drain_Take', actors: [OWNER], signatories: [OPERATOR], packageName: 'evil' };
    const { tx, hash } = await prepared(honest('open', AMULET, [...registryCalls(AMULET), extra]));
    expect(await refusal(() => signPreparedTransaction(signer(), tx, hash, policy(AMULET)))).toMatch(/owner's authority reaches Evil.Drain:Drain.Drain_Take/);
  });

  test('TC-SDK-3340-05: a registry choice other than Allocate or PublicFetch on a genuine factory is refused', async () => {
    const transfer: NodeSpec = { kind: 'exercise', template: AMULET.factory, choice: 'TransferFactory_Transfer', actors: [OWNER], signatories: [DSO], packageName: 'registry' };
    const { tx, hash } = await prepared(honest('open', AMULET, [...registryCalls(AMULET), transfer]));
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(AMULET)))).toMatch(/owner's authority reaches .*TransferFactory_Transfer/);
  });

  test('TC-SDK-3340-06: a policy naming a package outside the wallet\'s pin is refused', async () => {
    const { tx, hash } = await prepared(honest('open', AMULET));
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(AMULET, { intentPackageIds: ['f0'.repeat(32)] })))).toMatch(/not a version this wallet signs for/);
  });

  const at0_5_1 = (spec: ExerciseSpec): ExerciseSpec => JSON.parse(JSON.stringify(spec).replaceAll(INTENT_PKG, INTENT_0_5_1)) as ExerciseSpec;

  test.each(['open', 'renewSettlementFactory'] as const)('TC-SDK-3340-20: a cancore-intent 0.5.1 %s is refused', async (kind) => {
    const { tx, hash } = await prepared(at0_5_1(honest(kind, AMULET)));
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(AMULET)))).toMatch(/root is not a choice of an allowed cancore-intent package/);
  });

  test('TC-SDK-3340-21: a caller cannot widen the pin to cancore-intent 0.5.1', async () => {
    const { tx, hash } = await prepared(at0_5_1(honest('open', AMULET)));
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(AMULET, { intentPackageIds: [INTENT_PKG, INTENT_0_5_1] })))).toMatch(/not a version this wallet signs for/);
  });

  test('TC-SDK-3340-07: a root the policy does not expect is refused', async () => {
    const { tx, hash } = await prepared(honest('open', AMULET));
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(AMULET, { roots: ['renewSettlementFactory'] })))).toMatch(/not an intent operation this wallet signs/);
  });

  test('TC-SDK-3340-08: a transaction that also acts as the operator is refused', async () => {
    const { tx, hash } = await prepared(honest('open', AMULET), [OWNER, OPERATOR]);
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(AMULET)))).toMatch(/not as the owner alone/);
  });

  test('TC-SDK-3340-09: the factory of another registry than the policy admin is refused', async () => {
    const { tx, hash } = await prepared(honest('open', AMULET));
    const [, cbtc] = REGISTRIES as [Registry, Registry];
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(cbtc)))).toMatch(/not a factory of the registry/);
  });

  test('TC-SDK-3340-10: a contract the owner signs, created outside the registry and the intent package, is refused', async () => {
    const created: NodeSpec = { kind: 'create', template: `${ROGUE_PKG}:Evil.Debt:Debt`, signatories: [OWNER], packageName: 'evil' };
    const { tx, hash } = await prepared(honest('open', AMULET, [...registryCalls(AMULET), created]));
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(AMULET)))).toMatch(/owner signs a Evil.Debt:Debt/);
  });
});

describe('isRegistryFactory: admin among the signatories, or a package of the admin (CAN-3340)', () => {
  const preapproval = { templateId: '1eddd268bdd50d6e262722bea799c9455da032b3f94489e589975151b274b8c0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval', signatories: [OWNER] };

  test('TC-SDK-3340-11: the admin signs it, or its package is the admin’s; an unknown admin is refused', () => {
    expect(isRegistryFactory({ templateId: `${ROGUE_PKG}:X:Y`, signatories: [DSO] }, DSO)).toBe(true);
    expect(isRegistryFactory(preapproval, CBTC)).toBe(true);
    expect(isRegistryFactory(preapproval, DSO)).toBe(false);
    expect(isRegistryFactory({ templateId: `${ROGUE_PKG}:X:Y`, signatories: [OPERATOR] }, CBTC)).toBe(false);
    expect(isRegistryFactory({ templateId: `${ROGUE_PKG}:X:Y`, signatories: [OPERATOR] }, OPERATOR)).toBe(false);
    expect(REGISTRY_PACKAGES[CBTC]).toEqual(expect.arrayContaining(['1eddd268bdd50d6e262722bea799c9455da032b3f94489e589975151b274b8c0', '415a1ec96a9e2839453e9aa1c5c71b6511c008c79511cb6f873e0b7393fe3b92']));
  });
});

describe('an intent operation is never signed from a bare hash (CAN-3340)', () => {
  test('TC-SDK-3340-13: signPreparedHashBase64 and signLegs without a policy refuse intent.open', async () => {
    const { tx, hash } = await prepared(honest('open', AMULET));
    const key = signer();
    await expect(signPreparedHashBase64(key, hash, 'intent.open')).rejects.toThrow(UnexpectedLegError);
    await expect(signLegs(key, [{ legId: 'open-0', kind: 'escrow', hash, preparedTransaction: tx }], { operation: 'intent.open' })).rejects.toThrow(/only under an intent signing policy/);
    await expect(signLegs(key, [{ legId: 'open-0', kind: 'escrow', hash }], { operation: 'intent.open', intentPolicy: policy(AMULET) })).rejects.toThrow(/came without one/);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test('TC-SDK-3340-14: signLegs signs an honest Open leg under the policy, and refuses a Renew leg answered for intent.open', async () => {
    const open = await prepared(honest('open', AMULET));
    const renew = await prepared(honest('renewSettlementFactory', AMULET));
    const key = signer();
    await expect(signLegs(key, [{ legId: 'open-0', kind: 'escrow', hash: open.hash, preparedTransaction: open.tx }], { operation: 'intent.open', intentPolicy: policy(AMULET) })).resolves.toEqual([{ legId: 'open-0', signature: `sig:${open.hash}` }]);
    const reason = await refusal(() => signLegs(key, [{ legId: 'open-0', kind: 'escrow', hash: renew.hash, preparedTransaction: renew.tx }], { operation: 'intent.open', intentPolicy: policy(AMULET) }));
    expect(reason).toMatch(/not an intent operation this wallet signs/);
  });
});
