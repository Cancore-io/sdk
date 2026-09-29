import type { Hex, UintLike } from './typedData';

export interface TypedField {
  readonly name: string;
  readonly type: string;
}

export type TypedDataTypes = Readonly<Record<string, readonly TypedField[]>>;

export type TypedValue = string | number | bigint | boolean;

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: UintLike;
  verifyingContract?: Hex | string;
  salt?: Hex | string;
}

export interface TypedDataInput {
  domain: TypedDataDomain;
  types: TypedDataTypes;
  primaryType: string;
  message: Readonly<Record<string, unknown>>;
}

/** A JSON value JCS can canonicalise: numbers are safe integers only. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const notYet = (): never => {
  throw new Error('not implemented');
};

/** `Name(type1 name1,…)` of a flat struct. */
export function encodeType(_types: TypedDataTypes, _primaryType: string): string {
  return notYet();
}

export function typeHash(_types: TypedDataTypes, _primaryType: string): Hex {
  return notYet();
}

export function hashStruct(_types: TypedDataTypes, _primaryType: string, _message: Readonly<Record<string, unknown>>): Hex {
  return notYet();
}

export function hashDomain(_domain: TypedDataDomain): Hex {
  return notYet();
}

export function hashTypedData(_input: TypedDataInput): Hex {
  return notYet();
}

export function jcs(_value: unknown): string {
  return notYet();
}

export function gatewayBodyHash(_message: Readonly<Record<string, unknown>>): Hex {
  return notYet();
}

export function requestIdHash(_requestId: string): Hex {
  return notYet();
}
