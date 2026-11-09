/**
 * `@cancore/wallet/canton` — what every party that signs or attests on the Cancore intent rail
 * checks a Canton transaction with: the prepared-transaction view and hash, the registry
 * packages by admin and the factory rule, and the owner's signing policy (CAN-3340). Its
 * declarations need neither Node nor DOM types; the protobuf-typed functions are `./canton/proto`.
 */
export type { CantonTransaction, CreateNode, DamlValue, ExerciseNode, FetchNode, RollbackNode, TransactionNode } from './transactionTypes';
export * from './factories';
export * from './registry';
export * from './intentPolicy';
export * from './prepared';
