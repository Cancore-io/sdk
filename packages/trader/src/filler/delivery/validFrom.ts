import type { DecString } from '@cancore/contracts';
import type { Clock } from '../runtime';
import { reasonOf } from './reverts';
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
  /** Told each time the clock is past `validFrom` but the latest block is not (or is unreadable), so a stalled destination is visible. */
  onChainLag?: (detail: string) => void;
}

/**
 * `waiting` (with `wake` scheduled) until both the process clock and the
 * latest block have reached `validFrom`; undefined once they have. The router
 * compares `validFrom` with `block.timestamp`, and the latest block lags the
 * clock by up to a block time (CAN-2986).
 */
export async function awaitValidFrom({ clock, driver, validFrom, pollMs, wake, onChainLag }: ValidFromWait): Promise<{ status: 'waiting'; detail: string } | undefined> {
  const validFromMs = Number(validFrom) * 1000;
  if (clock.now() < validFromMs) {
    clock.schedule(validFromMs - clock.now(), wake);
    return { status: 'waiting', detail: 'validFrom not reached' };
  }
  let detail: string;
  try {
    const chainTime = await driver.chainTime();
    if (chainTime >= BigInt(validFrom)) return undefined;
    detail = `validFrom not reached on chain: latest block at ${chainTime}, validFrom ${validFrom}`;
  } catch (error) {
    detail = `latest block unreadable: ${reasonOf(error)}`;
  }
  onChainLag?.(detail);
  clock.schedule(pollMs, wake);
  return { status: 'waiting', detail };
}
