/**
 * A decoded prepared transaction as the operation checks read it: plain data,
 * no protobuf types. It is the SDK's own public shape, so a consumer of the
 * package typechecks without the Canton proto package (whose types need DOM).
 */
import type { DamlTransaction_Node, Identifier, PreparedTransaction, Value } from '@canton-network/core-ledger-proto';

/** A Daml value, tagged by kind. Numbers that do not fit a double stay decimal strings. */
export type DamlValue =
  | { t: 'unit' }
  | { t: 'bool'; v: boolean }
  | { t: 'int64'; v: string }
  | { t: 'numeric'; v: string }
  /** Microseconds since the epoch. */
  | { t: 'timestamp'; v: string }
  /** Days since the epoch. */
  | { t: 'date'; v: number }
  | { t: 'party'; v: string }
  | { t: 'text'; v: string }
  | { t: 'contractId'; v: string }
  | { t: 'optional'; v?: DamlValue }
  | { t: 'list'; v: DamlValue[] }
  | { t: 'textMap'; v: Record<string, DamlValue> }
  /** Fields by label; a field without a label is `#<position>`. */
  | { t: 'record'; v: Record<string, DamlValue> }
  | { t: 'variant'; constructor: string; v: DamlValue }
  | { t: 'enum'; constructor: string }
  | { t: 'genMap'; v: Array<[DamlValue, DamlValue]> };

interface NodeBase {
  nodeId: string;
}
interface ContractNode extends NodeBase {
  contractId: string;
  packageName: string;
  /** `<package id>:<module>:<entity>`. */
  templateId: string;
  signatories: string[];
  stakeholders: string[];
}
export interface CreateNode extends ContractNode {
  kind: 'create';
  argument: DamlValue;
}
export interface ExerciseNode extends ContractNode {
  kind: 'exercise';
  /** `<package id>:<module>:<entity>` of the interface the choice is exercised through, if any. */
  interfaceId?: string;
  choice: string;
  chosenValue: DamlValue;
  actingParties: string[];
  consuming: boolean;
  children: string[];
  result?: DamlValue;
}
export interface FetchNode extends ContractNode {
  kind: 'fetch';
  interfaceId?: string;
  actingParties: string[];
}
export interface RollbackNode extends NodeBase {
  kind: 'rollback';
  children: string[];
}
export type TransactionNode = CreateNode | ExerciseNode | FetchNode | RollbackNode;

export interface CantonTransaction {
  commandId: string;
  actAs: string[];
  roots: string[];
  nodes: Readonly<Record<string, TransactionNode>>;
  /** Contracts the transaction reads, as disclosed with it. */
  inputContracts: Array<Omit<CreateNode, 'nodeId' | 'kind'> & { argument: DamlValue }>;
  synchronizerId: string;
  /** Microseconds since the epoch, decimal. */
  preparationTime: string;
  minLedgerEffectiveTime?: string;
  maxLedgerEffectiveTime?: string;
}

const id = (identifier: Identifier | undefined): string => `${identifier?.packageId ?? ''}:${identifier?.moduleName ?? ''}:${identifier?.entityName ?? ''}`;

export function damlValue(value: Value | undefined): DamlValue {
  const sum = value?.sum;
  switch (sum?.oneofKind) {
    case 'unit':
      return { t: 'unit' };
    case 'bool':
      return { t: 'bool', v: sum.bool };
    case 'int64':
      return { t: 'int64', v: String(sum.int64) };
    case 'numeric':
      return { t: 'numeric', v: sum.numeric };
    case 'timestamp':
      return { t: 'timestamp', v: String(sum.timestamp) };
    case 'date':
      return { t: 'date', v: sum.date };
    case 'party':
      return { t: 'party', v: sum.party };
    case 'text':
      return { t: 'text', v: sum.text };
    case 'contractId':
      return { t: 'contractId', v: sum.contractId };
    case 'optional':
      return sum.optional.value === undefined ? { t: 'optional' } : { t: 'optional', v: damlValue(sum.optional.value) };
    case 'list':
      return { t: 'list', v: sum.list.elements.map(damlValue) };
    case 'textMap':
      return { t: 'textMap', v: Object.fromEntries(sum.textMap.entries.map((e) => [e.key, damlValue(e.value)])) };
    case 'record':
      return { t: 'record', v: Object.fromEntries(sum.record.fields.map((f, i) => [f.label || `#${i}`, damlValue(f.value)])) };
    case 'variant':
      return { t: 'variant', constructor: sum.variant.constructor, v: damlValue(sum.variant.value) };
    case 'enum':
      return { t: 'enum', constructor: sum.enum.constructor };
    case 'genMap':
      return { t: 'genMap', v: sum.genMap.entries.map((e) => [damlValue(e.key), damlValue(e.value)] as [DamlValue, DamlValue]) };
    default:
      throw new TypeError(`unsupported value ${String(sum?.oneofKind)}`);
  }
}

function node(n: DamlTransaction_Node): TransactionNode {
  if (n.versionedNode.oneofKind !== 'v1') throw new TypeError(`node ${n.nodeId}: unsupported node version`);
  const type = n.versionedNode.v1.nodeType;
  switch (type.oneofKind) {
    case 'create': {
      const c = type.create;
      return { nodeId: n.nodeId, kind: 'create', contractId: c.contractId, packageName: c.packageName, templateId: id(c.templateId), argument: damlValue(c.argument), signatories: [...c.signatories], stakeholders: [...c.stakeholders] };
    }
    case 'exercise': {
      const e = type.exercise;
      return {
        nodeId: n.nodeId,
        kind: 'exercise',
        contractId: e.contractId,
        packageName: e.packageName,
        templateId: id(e.templateId),
        ...(e.interfaceId ? { interfaceId: id(e.interfaceId) } : {}),
        choice: e.choiceId,
        chosenValue: damlValue(e.chosenValue),
        actingParties: [...e.actingParties],
        signatories: [...e.signatories],
        stakeholders: [...e.stakeholders],
        consuming: e.consuming,
        children: [...e.children],
        ...(e.exerciseResult ? { result: damlValue(e.exerciseResult) } : {}),
      };
    }
    case 'fetch': {
      const f = type.fetch;
      return {
        nodeId: n.nodeId,
        kind: 'fetch',
        contractId: f.contractId,
        packageName: f.packageName,
        templateId: id(f.templateId),
        ...(f.interfaceId ? { interfaceId: id(f.interfaceId) } : {}),
        actingParties: [...f.actingParties],
        signatories: [...f.signatories],
        stakeholders: [...f.stakeholders],
      };
    }
    case 'rollback':
      return { nodeId: n.nodeId, kind: 'rollback', children: [...type.rollback.children] };
    default:
      throw new TypeError(`node ${n.nodeId}: unsupported node type`);
  }
}

/** The plain view of a decoded prepared transaction. Throws on a node or value kind it does not know. */
export function transactionView(prepared: PreparedTransaction): CantonTransaction {
  const t = prepared.transaction;
  const m = prepared.metadata;
  if (!t || !m) throw new TypeError('a prepared transaction without its transaction or metadata');
  const nodes: Record<string, TransactionNode> = {};
  for (const n of t.nodes) {
    if (Object.hasOwn(nodes, n.nodeId)) throw new TypeError(`node ${n.nodeId} appears twice`);
    nodes[n.nodeId] = node(n);
  }
  return {
    commandId: m.submitterInfo?.commandId ?? '',
    actAs: [...(m.submitterInfo?.actAs ?? [])],
    roots: [...t.roots],
    nodes,
    inputContracts: m.inputContracts.map((c) => {
      if (c.contract.oneofKind !== 'v1') throw new TypeError('unsupported input contract version');
      const v1 = c.contract.v1;
      return { contractId: v1.contractId, packageName: v1.packageName, templateId: id(v1.templateId), argument: damlValue(v1.argument), signatories: [...v1.signatories], stakeholders: [...v1.stakeholders] };
    }),
    synchronizerId: m.synchronizerId,
    preparationTime: String(m.preparationTime),
    ...(m.minLedgerEffectiveTime !== undefined ? { minLedgerEffectiveTime: String(m.minLedgerEffectiveTime) } : {}),
    ...(m.maxLedgerEffectiveTime !== undefined ? { maxLedgerEffectiveTime: String(m.maxLedgerEffectiveTime) } : {}),
  };
}
