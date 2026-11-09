import { type DamlTransaction_Node, PreparedTransaction, type Value } from '@canton-network/core-ledger-proto';
import { computeMultiHashForTopology, computeSha256CantonHash, hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import { bytesToHex } from '@noble/hashes/utils';
import { cantonHash, fromBase64, hashPreparedTransactionV2, multiHashInput } from './hashing';
import { transactionView } from './transaction';

const v = {
  unit: (): Value => ({ sum: { oneofKind: 'unit', unit: {} } }),
  bool: (bool: boolean): Value => ({ sum: { oneofKind: 'bool', bool } }),
  int64: (int64: string): Value => ({ sum: { oneofKind: 'int64', int64 } }),
  numeric: (numeric: string): Value => ({ sum: { oneofKind: 'numeric', numeric } }),
  timestamp: (timestamp: string): Value => ({ sum: { oneofKind: 'timestamp', timestamp } }),
  date: (date: number): Value => ({ sum: { oneofKind: 'date', date } }),
  party: (party: string): Value => ({ sum: { oneofKind: 'party', party } }),
  text: (text: string): Value => ({ sum: { oneofKind: 'text', text } }),
  cid: (contractId: string): Value => ({ sum: { oneofKind: 'contractId', contractId } }),
  some: (value: Value): Value => ({ sum: { oneofKind: 'optional', optional: { value } } }),
  none: (): Value => ({ sum: { oneofKind: 'optional', optional: {} } }),
  list: (elements: Value[]): Value => ({ sum: { oneofKind: 'list', list: { elements } } }),
  textMap: (entries: Record<string, Value>): Value => ({ sum: { oneofKind: 'textMap', textMap: { entries: Object.entries(entries).map(([key, value]) => ({ key, value })) } } }),
  record: (fields: Record<string, Value>): Value => ({ sum: { oneofKind: 'record', record: { fields: Object.entries(fields).map(([label, value]) => ({ label, value })) } } }),
  variant: (constructor: string, value: Value): Value => ({ sum: { oneofKind: 'variant', variant: { constructor, value } } }),
  enumOf: (constructor: string): Value => ({ sum: { oneofKind: 'enum', enum: { constructor } } }),
  genMap: (entries: Array<[Value, Value]>): Value => ({ sum: { oneofKind: 'genMap', genMap: { entries: entries.map(([key, value]) => ({ key, value })) } } }),
};
const template = { packageId: 'ab'.repeat(32), moduleName: 'Cancore.Intent.Delivery', entityName: 'DeliveryOrder' };
const node = (nodeId: string, nodeType: Extract<DamlTransaction_Node['versionedNode'], { oneofKind: 'v1' }>['v1']['nodeType']): DamlTransaction_Node => ({
  nodeId,
  versionedNode: { oneofKind: 'v1', v1: { nodeType } },
});

/** A transaction with every node kind and every value kind the encoding knows. */
function richTransaction(): PreparedTransaction {
  const everyValue = v.record({
    unit: v.unit(),
    bool: v.bool(true),
    int64: v.int64('-42'),
    numeric: v.numeric('1200.2500000000'),
    timestamp: v.timestamp('1790000000000000'),
    date: v.date(20_000),
    party: v.party('filler::1220aa'),
    text: v.text('ünïcode'),
    cid: v.cid('00'.repeat(34)),
    some: v.some(v.text('x')),
    none: v.none(),
    list: v.list([v.int64('1'), v.int64('2')]),
    textMap: v.textMap({ a: v.bool(false) }),
    variant: v.variant('Some', v.unit()),
    enumOf: v.enumOf('Red'),
    genMap: v.genMap([[v.text('k'), v.int64('7')]]),
  });
  const nodes: DamlTransaction_Node[] = [
    node('0', {
      oneofKind: 'exercise',
      exercise: {
        lfVersion: '2.1', contractId: '01'.repeat(34), packageName: 'cancore-intent', templateId: template,
        signatories: ['op::1220aa'], stakeholders: ['op::1220aa', 'filler::1220aa'], actingParties: ['filler::1220aa'],
        interfaceId: { packageId: 'cd'.repeat(32), moduleName: 'Splice.Api.Token.TransferInstructionV1', entityName: 'TransferFactory' },
        choiceId: 'DeliveryOrder_Fill', chosenValue: everyValue, consuming: true, exerciseResult: v.cid('02'.repeat(34)),
        children: ['1', '2', '3'], choiceObservers: ['obs::1220aa'],
      },
    }),
    node('1', {
      oneofKind: 'create',
      create: { lfVersion: '2.1', contractId: '03'.repeat(34), packageName: 'cancore-intent', templateId: template, argument: everyValue, signatories: ['op::1220aa'], stakeholders: ['op::1220aa'] },
    }),
    node('2', {
      oneofKind: 'fetch',
      fetch: { lfVersion: '2.1', contractId: '04'.repeat(34), packageName: 'cancore-intent', templateId: template, signatories: ['op::1220aa'], stakeholders: ['op::1220aa'], actingParties: ['filler::1220aa'] },
    }),
    node('3', { oneofKind: 'rollback', rollback: { children: ['4'] } }),
    node('4', {
      oneofKind: 'create',
      create: { lfVersion: '2.1', contractId: '05'.repeat(34), packageName: 'cancore-intent', templateId: template, argument: v.record({}), signatories: [], stakeholders: [] },
    }),
  ];
  return PreparedTransaction.create({
    transaction: { version: '2.1', roots: ['0'], nodes, nodeSeeds: [{ nodeId: 0, seed: new Uint8Array(32).fill(7) }, { nodeId: 1, seed: new Uint8Array(32).fill(8) }] },
    metadata: {
      submitterInfo: { actAs: ['filler::1220aa'], commandId: 'cmd-1' },
      synchronizerId: 'global-domain::1220dso',
      mediatorGroup: 0,
      transactionUuid: '00000000-0000-4000-8000-000000000000',
      preparationTime: 1_000_000_000_000_000n,
      minLedgerEffectiveTime: 1_000_000_000_000_001n,
      inputContracts: [
        {
          contract: { oneofKind: 'v1', v1: { lfVersion: '2.1', contractId: '06'.repeat(34), packageName: 'cancore-intent', templateId: template, argument: everyValue, signatories: ['op::1220aa'], stakeholders: ['op::1220aa'] } },
          createdAt: 1_000_000_000_000_000n,
          eventBlob: new Uint8Array(),
        },
      ],
      globalKeyMapping: [],
    },
  });
}

describe('hashing scheme V2, ported: the same bytes as @canton-network/core-tx-visualizer', () => {
  test('every node kind and every value kind', async () => {
    const tx = richTransaction();
    expect(bytesToHex(hashPreparedTransactionV2(tx))).toBe(await hashPreparedTransaction(tx, 'hex'));
  });

  test('an empty transaction, and one without optional metadata', async () => {
    const tx = richTransaction();
    tx.transaction = { version: '2.1', roots: [], nodes: [], nodeSeeds: [] };
    tx.metadata!.minLedgerEffectiveTime = undefined;
    tx.metadata!.inputContracts = [];
    expect(bytesToHex(hashPreparedTransactionV2(tx))).toBe(await hashPreparedTransaction(tx, 'hex'));
  });

  test('one changed field changes the hash', () => {
    const a = richTransaction();
    const b = richTransaction();
    b.metadata!.submitterInfo!.commandId = 'cmd-2';
    expect(bytesToHex(hashPreparedTransactionV2(a))).not.toBe(bytesToHex(hashPreparedTransactionV2(b)));
  });

  test('an int64 beyond 2^53 keeps every digit (the library rounds it through a double)', () => {
    const a = richTransaction();
    const b = richTransaction();
    const big = (tx: PreparedTransaction, n: string) => {
      const create = tx.transaction!.nodes[1]!.versionedNode;
      if (create.oneofKind === 'v1' && create.v1.nodeType.oneofKind === 'create') create.v1.nodeType.create.argument = v.record({ n: v.int64(n) });
    };
    big(a, '9007199254740993');
    big(b, '9007199254740992');
    expect(bytesToHex(hashPreparedTransactionV2(a))).not.toBe(bytesToHex(hashPreparedTransactionV2(b)));
  });

  test('an exercise without a seed is an error, not a hash', () => {
    const tx = richTransaction();
    tx.transaction!.nodeSeeds = [];
    expect(() => hashPreparedTransactionV2(tx)).toThrow(/no seed/);
  });
});

describe('topology multihash and base64', () => {
  test('the purpose hash and the multihash input match the library', async () => {
    const hashes = [new Uint8Array([9, 9]), new Uint8Array([1, 2, 3])].map((b) => cantonHash(11, b));
    for (const [i, b] of [new Uint8Array([9, 9]), new Uint8Array([1, 2, 3])].entries()) {
      expect(bytesToHex(hashes[i]!)).toBe(bytesToHex(await computeSha256CantonHash(11, b)));
    }
    expect(bytesToHex(multiHashInput(hashes))).toBe(bytesToHex(await computeMultiHashForTopology(hashes)));
  });

  test('base64 decodes like Node, strictly', () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 100]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
      const b64 = Buffer.from(bytes).toString('base64');
      expect(fromBase64(b64)).toEqual(bytes);
      expect(fromBase64(b64.replace(/=+$/, ''))).toEqual(bytes);
    }
    for (const bad of ['a', 'ab$c', 'a-b_']) expect(() => fromBase64(bad)).toThrow(/not base64/);
  });
});

describe('the plain view of a decoded transaction', () => {
  test('nodes, values and metadata as plain data', () => {
    const view = transactionView(richTransaction());
    expect(view).toMatchObject({ commandId: 'cmd-1', actAs: ['filler::1220aa'], roots: ['0'], preparationTime: '1000000000000000', minLedgerEffectiveTime: '1000000000000001' });
    const root = view.nodes['0']!;
    expect(root).toMatchObject({ kind: 'exercise', choice: 'DeliveryOrder_Fill', templateId: `${'ab'.repeat(32)}:Cancore.Intent.Delivery:DeliveryOrder`, actingParties: ['filler::1220aa'], children: ['1', '2', '3'], result: { t: 'contractId', v: '02'.repeat(34) } });
    expect(root.kind === 'exercise' && root.interfaceId).toBe(`${'cd'.repeat(32)}:Splice.Api.Token.TransferInstructionV1:TransferFactory`);
    expect(root.kind === 'exercise' && root.chosenValue).toMatchObject({
      t: 'record',
      v: {
        int64: { t: 'int64', v: '-42' },
        numeric: { t: 'numeric', v: '1200.2500000000' },
        party: { t: 'party', v: 'filler::1220aa' },
        some: { t: 'optional', v: { t: 'text', v: 'x' } },
        none: { t: 'optional' },
        list: { t: 'list', v: [{ t: 'int64', v: '1' }, { t: 'int64', v: '2' }] },
        textMap: { t: 'textMap', v: { a: { t: 'bool', v: false } } },
        variant: { t: 'variant', constructor: 'Some', v: { t: 'unit' } },
        enumOf: { t: 'enum', constructor: 'Red' },
        genMap: { t: 'genMap', v: [[{ t: 'text', v: 'k' }, { t: 'int64', v: '7' }]] },
      },
    });
    expect(view.nodes['2']).toMatchObject({ kind: 'fetch', actingParties: ['filler::1220aa'] });
    expect(view.nodes['3']).toEqual({ nodeId: '3', kind: 'rollback', children: ['4'] });
    expect(view.inputContracts[0]).toMatchObject({ contractId: '06'.repeat(34), signatories: ['op::1220aa'] });
  });

  test('a node id that appears twice is refused', () => {
    const tx = richTransaction();
    tx.transaction!.nodes.push({ ...tx.transaction!.nodes[1]! });
    expect(() => transactionView(tx)).toThrow(/appears twice/);
  });
});
