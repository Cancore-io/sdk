import type { DecString } from '@cancore/contracts';
import type { Clock } from '../runtime';
import type { TransactionDriver } from './transactions';

export interface ValidFromWait {
  clock: Clock;
  driver: Pick<TransactionDriver, 'chainTime'>;
  /** `ticket.validFrom`, unix s. */
  validFrom: DecString;
  /** How soon the latest block is read again while it is short of `validFrom`, ms. */
  pollMs: number;
  /** Runs the delivery again. */
  wake: () => void;
}

/**
 * `waiting` (with `wake` scheduled) until both the process clock and the
 * latest block have reached `validFrom`; undefined once they have. The router
 * compares `validFrom` with `block.timestamp`, and the latest block lags the
 * clock by up to a block time (CAN-2986).
 */
export async function awaitValidFrom({ clock, driver, validFrom, pollMs, wake }: ValidFromWait): Promise<{ status: 'waiting'; detail: string } | undefined> {
  const validFromMs = Number(validFrom) * 1000;
  if (clock.now() < validFromMs) {
    clock.schedule(validFromMs - clock.now(), wake);
    return { status: 'waiting', detail: 'validFrom not reached' };
  }
  let chainTime: bigint;
  try {
    chainTime = await driver.chainTime();
  } catch (error) {
    clock.schedule(pollMs, wake);
    return { status: 'waiting', detail: `latest block unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (chainTime >= BigInt(validFrom)) return undefined;
  clock.schedule(pollMs, wake);
  return { status: 'waiting', detail: `validFrom not reached on chain: latest block at ${chainTime}, validFrom ${validFrom}` };
}
