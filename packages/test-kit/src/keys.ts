export type Hex = `0x${string}`;
export interface TestKey { privateKey: Hex; address: Hex }
export type TestKeyRole = 'gateway' | 'ticketSigner' | 'foreignSigner' | 'acmeQuote' | 'acmeFiller' | 'zetaQuote' | 'zetaFiller';
export class BadSignatureError extends Error {}
const todo = (): never => { throw new Error('not implemented'); };
export function testKey(_role: string): TestKey { return todo(); }
export const TEST_KEYS = {} as Readonly<Record<TestKeyRole, TestKey>>;
export function addressOf(_privateKey: Hex): Hex { return todo(); }
export function sign(_digest: Hex, _privateKey: Hex): Hex { return todo(); }
export function recover(_digest: Hex, _sig: Hex): Hex { return todo(); }
