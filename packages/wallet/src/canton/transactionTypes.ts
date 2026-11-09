/**
 * A decoded prepared transaction as the operation checks read it: plain data,
 * no protobuf types. It is the SDK's own public shape, so a consumer of the
 * package typechecks without the Canton proto package (whose types need DOM).
 */
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
