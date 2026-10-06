/**
 * The envelope of every filler → filler-gateway message (protocol §3.4,
 * T-13): `fillerId`, `sentAt` and `msgSig` — the message key's signature over
 * `FillerMessage{bodyHash}`, `bodyHash = keccak256(JCS(message without
 * msgSig))`. No exceptions: `pong`, `ticket.decline`, a declining
 * `quote.reconfirm.reply` and `error` are sealed like a `quote`; a REST
 * request body is the same sealed message.
 */
import { FILLER_MESSAGE_TYPES, FILLER_PROTOCOL_DOMAIN, fillerMessageBodyHash, type F2SMessage } from '@cancore/contracts';
import type { Clock } from '../runtime';
import { signTypedDataChecked, type QuoteSigner } from '../signer';

/** A filler → filler-gateway message before its envelope: everything but `fillerId`, `sentAt` and `msgSig`. */
export type Unsealed<T extends F2SMessage = F2SMessage> = T extends unknown ? Omit<T, 'fillerId' | 'sentAt' | 'msgSig'> : never;

/** Adds `fillerId` and `sentAt` (now) and signs the result with the message key. */
export type Sealer = <T extends F2SMessage>(message: Unsealed<T>) => Promise<T>;

export interface SealerOptions {
  fillerId: string;
  /** The message key (today the quote key): the one key every filler message is signed with. */
  messageSigner: QuoteSigner;
  clock: Clock;
}

export function createSealer(options: SealerOptions): Sealer {
  return async <T extends F2SMessage>(message: Unsealed<T>): Promise<T> => {
    const body = { ...message, fillerId: options.fillerId, sentAt: options.clock.now() };
    const msgSig = await signTypedDataChecked(options.messageSigner, {
      domain: FILLER_PROTOCOL_DOMAIN,
      types: FILLER_MESSAGE_TYPES,
      primaryType: 'FillerMessage',
      message: { bodyHash: fillerMessageBodyHash(body) },
    });
    return { ...body, msgSig } as unknown as T;
  };
}
