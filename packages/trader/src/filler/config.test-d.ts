/**
 * TC-SDK-2151-08 (D-15): the public filler configuration carries one message key — `quoteSigner` signs quotes,
 * ticket intents, receipts and every envelope — and no separate quote or receipt key. Checked by `tsc`, not run:
 * the property is the shape of the type, so a stand run would prove nothing about it.
 */
import type { createFiller, FillerConfig } from './index';
import type { TypedDataSigner } from './signer';

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type TypedDataSignerFields<T> = { [K in keyof T]-?: NonNullable<T[K]> extends TypedDataSigner ? K : never }[keyof T];

export const oneMessageKey: Exactly<TypedDataSignerFields<FillerConfig>, 'quoteSigner'> = true;
export const createFillerTakesIt: Exactly<Parameters<typeof createFiller>[0], FillerConfig> = true;

declare const config: FillerConfig;
// @ts-expect-error no separate receipt key
void config.receiptSigner;
// @ts-expect-error no separate receipt key
void config.receiptKey;
// @ts-expect-error the message key is `quoteSigner`, not a second key
void config.quoteKey;
// @ts-expect-error the message key is `quoteSigner`, not a second key
void config.messageSigner;
