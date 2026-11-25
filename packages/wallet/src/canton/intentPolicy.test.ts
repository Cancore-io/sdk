import { type DamlTransaction_Node, type Metadata_InputContract, PreparedTransaction, type RecordField, type Value } from '@canton-network/core-ledger-proto';
import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import { describe, expect, jest, test } from '@jest/globals';
import { signLegs, signPreparedHashBase64, signPreparedTransaction, UnexpectedLegError, type HashSigner } from '../operations';
import { INTENT_PACKAGE_IDS, IntentTransactionRefusedError, type IntentRoot, type IntentSigningPolicy } from './intentPolicy';
import { verifyPreparedTransaction } from './prepared';
import { isRegistryFactory, REGISTRY_GUARDIANS, REGISTRY_PACKAGES, registryGuardiansOf, registryPackagesOf } from './registry';
import { CANTON_TRANSFER_FACTORIES } from './factories';

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
// dev's CNRX guardian G (CAN-3132), the one CANTON_TRANSFER_FACTORIES pins for the CNRX admin.
const CNRX_GUARDIAN = 'cancore-intent-guardian::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b';
const CNRX_GUARDIAN_PRIME = 'cnrx-guardian-prime::1220' + '0d'.repeat(32);

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
  contractId?: string;
  consuming?: boolean;
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

function root(kind: Exclude<IntentRoot, 'withdraw'>, children: NodeSpec[]): ExerciseSpec {
  return kind === 'open'
    ? { kind: 'exercise', template: intent('Intent.SwapIntent:IntentFactory'), choice: 'IntentFactory_Open', actors: [OWNER], signatories: [OPERATOR], children }
    : { kind: 'exercise', template: intent('Intent.SwapIntent:SwapIntent'), choice: 'SwapIntent_RenewSettlementFactory', actors: [OWNER], signatories: [OWNER, OPERATOR], children };
}

function honest(kind: Exclude<IntentRoot, 'withdraw'>, r: Registry, calls = registryCalls(r)): ExerciseSpec {
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
  const common = { lfVersion: '2.1', contractId: spec.kind === 'exercise' && spec.contractId ? spec.contractId : cid(slot), packageName: spec.kind !== 'fetch' && spec.packageName ? spec.packageName : 'cancore-intent', templateId: identifier(spec.template), signatories: spec.signatories, stakeholders: spec.signatories };
  let nodeType: Extract<DamlTransaction_Node['versionedNode'], { oneofKind: 'v1' }>['v1']['nodeType'];
  if (spec.kind === 'create') nodeType = { oneofKind: 'create', create: { ...common, argument: unit } };
  else if (spec.kind === 'fetch') nodeType = { oneofKind: 'fetch', fetch: { ...common, actingParties: [OWNER] } };
  else {
    seeds.push({ nodeId: slot, seed: new Uint8Array(32).fill(slot + 1) });
    const children = (spec.children ?? []).map((child) => build(child, nodes, seeds));
    nodeType = {
      oneofKind: 'exercise',
      exercise: { ...common, ...(spec.interface ? { interfaceId: identifier(spec.interface) } : {}), actingParties: spec.actors, choiceId: spec.choice, chosenValue: unit, consuming: spec.consuming ?? false, choiceObservers: [], children },
    };
  }
  nodes[slot] = { nodeId, versionedNode: { oneofKind: 'v1', v1: { nodeType } } };
  return nodeId;
}

async function prepared(spec: ExerciseSpec, actAs = [OWNER], inputContracts: Metadata_InputContract[] = []): Promise<{ tx: string; hash: string }> {
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
      inputContracts,
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
  const ROOTS: Array<Exclude<IntentRoot, 'withdraw'>> = ['open', 'renewSettlementFactory'];
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

  test.each(['open', 'renewSettlementFactory'] as const)('CAN-3588: a cancore-intent 0.6.3 %s is signed before 0.6.3 is uploaded', async (kind) => {
    const v063 = INTENT_PACKAGE_IDS.find((id) => id.startsWith('58e6e789')) as string;
    const at0_6_3 = JSON.parse(JSON.stringify(honest(kind, AMULET)).replaceAll(INTENT_PKG, v063)) as ExerciseSpec;
    const { tx, hash } = await prepared(at0_6_3);
    expect(v063).toBe('58e6e78939044edae7fc85c50800dd054d481c0fd8f057f3755b6d621313f305');
    expect(INTENT_PACKAGE_IDS).not.toContain('535cb88a2faec69ec361089d1d5ecbbe150cd50a00b736b2941b52c6b820b6fa');
    expect(verifyPreparedTransaction(tx, hash, policy(AMULET))).toBe(kind);
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

describe('BUG-1611: a factory the admin signs from a package outside the pin is not the registry\'s', () => {
  const drain: NodeSpec = { kind: 'exercise', template: AMULET.factory, choice: 'TransferFactory_Transfer', actors: [OWNER], signatories: [DSO], packageName: 'registry' };

  test.each(REGISTRIES.map((r) => [r.name, r] as const))('%s: a rogue-package factory signed like the genuine one is refused, so its subtree cannot spend the owner\'s holdings', async (_name, r) => {
    const rogue = `${ROGUE_PKG}:Evil.Factory:EvilSettlementFactory`;
    const [publicFetch] = registryCalls(r, rogue) as [ExerciseSpec];
    const { tx, hash } = await prepared(honest('renewSettlementFactory', r, [{ ...publicFetch, children: [drain] }]));
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(r)))).toMatch(/not a factory of the registry/);
  });

  test('a pinned-package factory a stranger signs is refused: the admin signs every genuine factory', () => {
    expect(isRegistryFactory({ templateId: AMULET.factory, signatories: [OPERATOR] }, DSO)).toBe(false);
    for (const r of REGISTRIES) expect(isRegistryFactory({ templateId: r.factory, signatories: r.factorySignatories }, r.admin)).toBe(true);
  });
});

describe('isRegistryFactory: admin among the signatories, and a package of the admin (CAN-3340, BUG-1611)', () => {
  const preapproval = { templateId: '1eddd268bdd50d6e262722bea799c9455da032b3f94489e589975151b274b8c0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval', signatories: [OWNER] };

  test('TC-SDK-3340-11: the admin signs it and its package is the admin’s; an unknown admin is refused', () => {
    expect(isRegistryFactory({ templateId: `${ROGUE_PKG}:X:Y`, signatories: [DSO] }, DSO)).toBe(false);
    expect(isRegistryFactory(preapproval, CBTC)).toBe(false);
    expect(isRegistryFactory({ ...preapproval, signatories: [OWNER, CBTC] }, CBTC)).toBe(true);
    expect(isRegistryFactory(preapproval, DSO)).toBe(false);
    expect(isRegistryFactory({ templateId: `${ROGUE_PKG}:X:Y`, signatories: [OPERATOR] }, CBTC)).toBe(false);
    expect(isRegistryFactory({ templateId: `${ROGUE_PKG}:X:Y`, signatories: [OPERATOR] }, OPERATOR)).toBe(false);
    expect(REGISTRY_PACKAGES[CBTC]).toEqual(expect.arrayContaining(['1eddd268bdd50d6e262722bea799c9455da032b3f94489e589975151b274b8c0', '415a1ec96a9e2839453e9aa1c5c71b6511c008c79511cb6f873e0b7393fe3b92']));
  });
});

describe('isRegistryFactory of a CNRX admin with a guardian G: G signs the factory too (CAN-3132)', () => {
  const RULES = '0cc44c28f323b455c1875e85fd7a1ad7732ad2a34ed8dd1550cb79dead750bba:Cnrx.Rules:CnrxRules';

  test('TC-SDK-3132-01: admin + G is the registry\'s; admin + G\', the admin alone, or G\'s package without G are not', () => {
    expect(REGISTRY_GUARDIANS[CNRX]).toBe(CNRX_GUARDIAN);
    expect(isRegistryFactory({ templateId: RULES, signatories: [CNRX, CNRX_GUARDIAN] }, CNRX)).toBe(true);
    expect(isRegistryFactory({ templateId: RULES, signatories: [CNRX, CNRX_GUARDIAN_PRIME] }, CNRX)).toBe(false);
    expect(isRegistryFactory({ templateId: RULES, signatories: [CNRX] }, CNRX)).toBe(false);
    expect(isRegistryFactory({ templateId: RULES, signatories: [CNRX_GUARDIAN_PRIME] }, CNRX)).toBe(false);
    // Without a G for the admin a cnrx-registry factory is refused, admin-signed or not (fail-closed); any other factory
    // keeps the CAN-3340 rule, even for an admin named like an Object.prototype key.
    expect(isRegistryFactory({ templateId: RULES, signatories: [CNRX, CNRX_GUARDIAN] }, CNRX, REGISTRY_PACKAGES, {})).toBe(false);
    expect(isRegistryFactory({ templateId: RULES.replace('Cnrx.Rules:CnrxRules', 'Cnrx.Allocation:CnrxAllocationRules'), signatories: [CNRX] }, CNRX, REGISTRY_PACKAGES, {})).toBe(false);
    expect(isRegistryFactory({ templateId: RULES.replace('Cnrx.Rules:CnrxRules', 'Other.Rules:Rules'), signatories: [CNRX] }, CNRX, REGISTRY_PACKAGES, {})).toBe(true);
    expect(isRegistryFactory({ templateId: `${ROGUE_PKG}:X:Y`, signatories: ['constructor'] }, 'constructor', { constructor: [ROGUE_PKG] }, {})).toBe(true);
  });

  test('TC-SDK-3132-02: the guardian of an admin is the first of its entries that names one; an admin with none has no entry', () => {
    const [entry] = CANTON_TRANSFER_FACTORIES[CNRX]!;
    const plain = { ...entry!, guardian: undefined };
    expect(registryGuardiansOf({ [CNRX]: [plain, { ...plain, guardian: 'g::1220' }, { ...plain, guardian: 'h::1220' }], [DSO]: [plain] })).toStrictEqual({ [CNRX]: 'g::1220' });
  });

  test('TC-SDK-3132-04: a wallet with its own CNRX pin passes G in the policy; without it every cnrx-registry factory is refused', async () => {
    const STAND = 'stand-cnrx::1220' + '5e'.repeat(32);
    const G = 'stand-guardian::1220' + '6f'.repeat(32);
    const stand: Registry = { ...REGISTRIES[2]!, name: 'a stand\'s cnrx-registry', admin: STAND, factorySignatories: [STAND, G] };
    const registries = { [STAND]: [stand.factory.split(':')[0]!] };
    const signedBy = async (signatories: string[]) => prepared(honest('open', stand, registryCalls(stand, stand.factory, signatories)));

    const own = await signedBy([STAND, G]);
    expect(verifyPreparedTransaction(own.tx, own.hash, policy(stand, { registries, guardians: { [STAND]: G } }))).toBe('open');
    const forged = await signedBy([STAND, CNRX_GUARDIAN_PRIME]);
    expect(await refusal(() => verifyPreparedTransaction(forged.tx, forged.hash, policy(stand, { registries, guardians: { [STAND]: G } })))).toMatch(/not a factory of the registry/);
    expect(await refusal(() => verifyPreparedTransaction(own.tx, own.hash, policy(stand, { registries })))).toMatch(/not a factory of the registry/);
  });

  test('TC-SDK-3132-03: an intent open whose CNRX factory is anchored on another guardian G\' is refused before signing', async () => {
    const cnrx = REGISTRIES[2]!;
    const { tx, hash } = await prepared(honest('open', cnrx, registryCalls(cnrx, cnrx.factory, [CNRX, CNRX_GUARDIAN_PRIME])));
    expect(await refusal(() => verifyPreparedTransaction(tx, hash, policy(cnrx)))).toMatch(/not a factory of the registry/);
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

describe("BUG-1685: intent.refund is signed only as the owner's SwapIntent_Withdraw of the intent's own allocation", () => {
  const CNRX_REGISTRY = REGISTRIES[2] as Registry;
  const CNRX_PKG = CNRX_REGISTRY.factory.split(':')[0] as string;
  const INTENT_CID = cid(200);
  const ALLOCATION_CID = cid(201);
  const OTHER_ALLOCATION_CID = cid(202);
  const ALLOCATION_INTERFACE = `${'c3'.repeat(32)}:Splice.Api.Token.AllocationV2:Allocation`;
  // canton-contracts Intent/SwapIntent.daml, in declaration order.
  const SWAP_INTENT_FIELDS = [
    'owner', 'operator', 'filler', 'fillerId', 'requestId', 'orderHash', 'amount', 'instrumentId', 'allocationCid', 'allocationFactoryCid', 'settlementFactoryCid',
    'destination', 'minReceived', 'feeRate', 'fillDeadline', 'refundAfter', 'orderCreatedAt', 'bookGuardian', 'attestorGovernor', 'attestorSetId', 'attestorSetCommitment', 'createdAt',
  ];
  const party = (v: string): Value => ({ sum: { oneofKind: 'party', party: v } });
  const contractId = (v: string): Value => ({ sum: { oneofKind: 'contractId', contractId: v } });

  function swapIntent(
    over: {
      owner?: Value; allocationCid?: Value; fields?: (fields: RecordField[]) => RecordField[]; argument?: (fields: RecordField[]) => Value;
      contractId?: string; template?: string; packageId?: string; packageName?: string;
    } = {},
  ): Metadata_InputContract {
    const values: Record<string, Value> = { owner: over.owner ?? party(OWNER), allocationCid: over.allocationCid ?? contractId(ALLOCATION_CID) };
    const declared: RecordField[] = SWAP_INTENT_FIELDS.map((label) => ({ label, value: values[label] ?? unit }));
    const fields = over.fields ? over.fields(declared) : declared;
    const create = {
      lfVersion: '2.1', contractId: over.contractId ?? INTENT_CID, packageName: over.packageName ?? 'cancore-intent',
      templateId: identifier(over.template ?? `${over.packageId ?? INTENT_PKG}:Intent.SwapIntent:SwapIntent`),
      argument: over.argument ? over.argument(fields) : { sum: { oneofKind: 'record' as const, record: { fields } } }, signatories: [OWNER, OPERATOR], stakeholders: [OWNER, OPERATOR],
    };
    return { contract: { oneofKind: 'v1', v1: create }, createdAt: 1000000000000000n, eventBlob: new Uint8Array() };
  }

  const allocationWithdraw = (allocation = ALLOCATION_CID, over: Partial<ExerciseSpec> = {}): ExerciseSpec => ({
    kind: 'exercise', template: `${CNRX_PKG}:Cnrx.Allocation:CnrxAllocationV2`, interface: ALLOCATION_INTERFACE, choice: 'Allocation_Withdraw', actors: [OWNER], signatories: [CNRX, OWNER],
    packageName: 'cnrx-registry', contractId: allocation, ...over, children: [{ kind: 'create', template: CNRX_REGISTRY.holding, signatories: [OWNER, CNRX], packageName: 'cnrx-registry' }],
  });
  const withdraw = (children: NodeSpec[] = [allocationWithdraw()], template = intent('Intent.SwapIntent:SwapIntent')): ExerciseSpec => ({
    kind: 'exercise', template, choice: 'SwapIntent_Withdraw', actors: [OWNER], signatories: [OWNER, OPERATOR], contractId: INTENT_CID, children,
  });
  const refundLeg = async (spec = withdraw(), contracts = [swapIntent()]) => {
    const { tx, hash } = await prepared(spec, [OWNER], contracts);
    return { legId: 'refund-0', kind: 'escrow' as const, hash, preparedTransaction: tx };
  };
  const signRefund = (key: HashSigner, leg: Awaited<ReturnType<typeof refundLeg>>) => signLegs(key, [leg], { operation: 'intent.refund', intentPolicy: policy(CNRX_REGISTRY) });

  test("TC-SDK-1685-01: the owner's honest withdraw of the intent's own allocation is signed, and reads as the withdraw root", async () => {
    const leg = await refundLeg();
    const key = signer();
    await expect(signRefund(key, leg)).resolves.toEqual([{ legId: 'refund-0', signature: `sig:${leg.hash}` }]);
    expect(verifyPreparedTransaction(leg.preparedTransaction, leg.hash, policy(CNRX_REGISTRY))).toBe('withdraw');
  });

  test('TC-SDK-1685-02: another root answered for intent.refund is refused — a Renew of the same intent, or an Open', async () => {
    const key = signer();
    const renew = await prepared(honest('renewSettlementFactory', CNRX_REGISTRY));
    const open = await prepared(honest('open', CNRX_REGISTRY));
    for (const other of [renew, open]) {
      const reason = await refusal(() => signRefund(key, { legId: 'refund-0', kind: 'escrow', hash: other.hash, preparedTransaction: other.tx }));
      expect(reason).toMatch(/not an intent operation this wallet signs/);
    }
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test("TC-SDK-1685-03: a withdraw of another allocation than the intent's is refused", async () => {
    const key = signer();
    expect(await refusal(async () => signRefund(key, await refundLeg(withdraw([allocationWithdraw(OTHER_ALLOCATION_CID)]))))).toMatch(/the withdraw releases .*, not the intent's allocation/);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test.each<[string, NodeSpec]>([
    ['a second Allocation_Withdraw of another allocation', allocationWithdraw(OTHER_ALLOCATION_CID)],
    ['an AllocationFactory_Allocate on a genuine factory of the registry', registryCalls(CNRX_REGISTRY)[1] as NodeSpec],
    ['the FillerRegistryEntry_PublicFetch an Open makes', { kind: 'exercise', template: intent('Intent.FillerRegistry:FillerRegistryEntry'), choice: 'FillerRegistryEntry_PublicFetch', actors: [OWNER], signatories: [OPERATOR, FILLER] }],
    ['a holding the owner signs, created outside the registry', { kind: 'create', template: `${ROGUE_PKG}:Evil.Holding:Holding`, signatories: [OWNER], packageName: 'evil' }],
    ['a pinned cancore-intent contract the owner signs, which SwapIntent_Withdraw never creates', { kind: 'create', template: intent('Intent.SwapIntent:SwapIntent'), signatories: [OWNER, OPERATOR] }],
  ])('TC-SDK-1685-04: an owner action besides the withdraw is refused — %s', async (_name, extra) => {
    const key = signer();
    expect(await refusal(async () => signRefund(key, await refundLeg(withdraw([allocationWithdraw(), extra]))))).toMatch(/owner's authority reaches|created outside the registry|created under a withdraw|not the intent's allocation/);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test('TC-SDK-1685-05: a SwapIntent_Withdraw of a package outside the pin is refused', async () => {
    const rogue = `${ROGUE_PKG}:Intent.SwapIntent:SwapIntent`;
    const key = signer();
    const leg = await refundLeg(withdraw([allocationWithdraw()], rogue), [swapIntent({ template: rogue })]);
    expect(await refusal(() => signRefund(key, leg))).toMatch(/not a choice of an allowed cancore-intent package/);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test.each<[string, Metadata_InputContract[], RegExp]>([
    ['the intent is not disclosed', [], /does not disclose the SwapIntent it withdraws/],
    ["the intent is another party's", [swapIntent({ owner: party(OPERATOR) })], /not the owner's/],
    ["its owner is the owner's party id as text, not a party", [swapIntent({ owner: { sum: { oneofKind: 'text', text: OWNER } } })], /not the owner's/],
    [
      'its argument is a text map of the same labels in declaration order, not a record',
      [swapIntent({ argument: (fields) => ({ sum: { oneofKind: 'textMap', textMap: { entries: fields.map((f) => ({ key: f.label, value: f.value })) } } }) })],
      /field 0 of the intent withdrawn is not its owner/,
    ],
    [
      'the allocationCid label moved to position 9, onto the allocation the withdraw releases',
      [swapIntent({ allocationCid: contractId(OTHER_ALLOCATION_CID), fields: (f) => f.map((x, i) => (i === 8 ? { label: 'allocationFactoryCid', value: x.value } : i === 9 ? { label: 'allocationCid', value: contractId(ALLOCATION_CID) } : x)) })],
      /field 8 of the intent withdrawn is not its allocationCid/,
    ],
    ['the disclosed contract is not a SwapIntent', [swapIntent({ template: intent('Intent.SwapIntent:IntentFactory') })], /does not disclose the SwapIntent it withdraws/],
    ['the disclosed SwapIntent is of a package not named cancore-intent', [swapIntent({ packageName: 'evil-intent' })], /does not disclose the SwapIntent it withdraws/],
    ['its allocationCid is not a contract id', [swapIntent({ allocationCid: party(OWNER) })], /allocationCid is not a contract id/],
    ['a field label repeats', [swapIntent({ fields: (f) => f.map((x, i) => (i === 1 ? { label: 'filler', value: x.value } : x)) })], /does not decode .*repeats/],
    [
      'a numeric label on field 1 would sort first and shift every position',
      [swapIntent({ fields: (f) => f.map((x, i) => (i === 1 ? { label: '0', value: x.value } : x)) })],
      /does not decode .*a number/,
    ],
    [
      'a __proto__ label hides field 1 so the allocationCid label at position 9 reads as position 8',
      [
        swapIntent({
          allocationCid: contractId(OTHER_ALLOCATION_CID),
          fields: (f) =>
            f.map((x, i) =>
              i === 1 ? { label: '__proto__', value: x.value } : i === 8 ? { label: 'x', value: x.value } : i === 9 ? { label: 'allocationCid', value: contractId(ALLOCATION_CID) } : x,
            ),
        }),
      ],
      /does not decode .*__proto__/,
    ],
  ])("TC-SDK-1685-06: the intent's own allocation is read strictly from the disclosed SwapIntent — refused when %s", async (_name, contracts, reason) => {
    const key = signer();
    expect(await refusal(async () => signRefund(key, await refundLeg(withdraw(), contracts)))).toMatch(reason);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test('TC-SDK-1685-07: unlabelled fields are read by position: the honest withdraw is signed', async () => {
    const leg = await refundLeg(withdraw(), [swapIntent({ fields: (f) => f.map((x) => ({ label: '', value: x.value })) })]);
    await expect(signRefund(signer(), leg)).resolves.toHaveLength(1);
  });

  test('TC-SDK-1685-08: intent.refund is never signed from a bare hash', async () => {
    const leg = await refundLeg();
    const key = signer();
    await expect(signPreparedHashBase64(key, leg.hash, 'intent.refund')).rejects.toThrow(UnexpectedLegError);
    await expect(signLegs(key, [leg], { operation: 'intent.refund' })).rejects.toThrow(/only under an intent signing policy/);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test.each<[string, Partial<ExerciseSpec>, RegExp]>([
    ['another choice of the allocation', { choice: 'Allocation_Cancel' }, /the owner's authority reaches Cnrx.Allocation:CnrxAllocationV2.Allocation_Cancel/],
    ['Allocation_Withdraw not through the token-standard Allocation interface', { interface: `${ROGUE_PKG}:Evil.Allocation:Allocation` }, /the owner's authority reaches/],
    ['an allocation the admin does not sign', { signatories: [OWNER] }, /is not the registry's of/],
    ['an allocation of a package outside the registry pin', { template: `${ROGUE_PKG}:Cnrx.Allocation:CnrxAllocationV2` }, /is not the registry's of/],
  ])("TC-SDK-1685-09: the intent's own allocation is released only by the registry's Allocation_Withdraw — refused for %s", async (_name, over, reason) => {
    const key = signer();
    expect(await refusal(async () => signRefund(key, await refundLeg(withdraw([allocationWithdraw(ALLOCATION_CID, over)]))))).toMatch(reason);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test("TC-SDK-1685-11: the SwapIntent is the disclosed contract of the root's id, wherever it sits among the inputs", async () => {
    const DECOY_INTENT_CID = cid(203);
    const decoy = swapIntent({ contractId: DECOY_INTENT_CID, allocationCid: contractId(OTHER_ALLOCATION_CID) });
    const holding = swapIntent({ contractId: cid(204), template: CNRX_REGISTRY.holding, packageName: 'cnrx-registry' });
    await expect(signRefund(signer(), await refundLeg(withdraw(), [holding, swapIntent()]))).resolves.toHaveLength(1);
    await expect(signRefund(signer(), await refundLeg(withdraw(), [decoy, swapIntent()]))).resolves.toHaveLength(1);
    const key = signer();
    const decoysAllocation = await refundLeg(withdraw([allocationWithdraw(OTHER_ALLOCATION_CID)]), [decoy, swapIntent()]);
    expect(await refusal(() => signRefund(key, decoysAllocation))).toMatch(/the withdraw releases .*, not the intent's allocation/);
    expect(key.signPreparedHash).not.toHaveBeenCalled();
  });

  test("TC-SDK-1685-12: an allocation of the registry's allocationPackageId, a package none of its other templates use, is the registry's", async () => {
    const ALLOCATION_PKG = 'c4'.repeat(32);
    const cnrx = CANTON_TRANSFER_FACTORIES[CNRX] ?? [];
    const registries = registryPackagesOf({ [CNRX]: cnrx.map((f) => ({ ...f, allocationPackageId: ALLOCATION_PKG })) });
    const leg = await refundLeg(withdraw([allocationWithdraw(ALLOCATION_CID, { template: `${ALLOCATION_PKG}:Cnrx.Allocation:CnrxAllocationV2` })]));
    await expect(signLegs(signer(), [leg], { operation: 'intent.refund', intentPolicy: policy(CNRX_REGISTRY, { registries }) })).resolves.toHaveLength(1);
    expect(await refusal(() => signRefund(signer(), leg))).toMatch(/is not the registry's of/);
  });

  test('TC-SDK-1685-10: an intent created under a cancore-intent version outside the pin stays withdrawable: the root runs pinned code', async () => {
    const leg = await refundLeg(withdraw(), [swapIntent({ packageId: INTENT_0_5_1 })]);
    await expect(signRefund(signer(), leg)).resolves.toHaveLength(1);
  });
});
