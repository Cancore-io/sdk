/** Why a delivery was not started. */
export type FillRefusal =
  /** No `ticket.receipt` went out for the attempt (T-22). */
  | 'no-receipt'
  /** Not an EVM ticket, or no fill key or router for its destination. */
  | 'not-deliverable'
  /** The issued ticket does not name this filler, its delivery key or its payee (S13). */
  | 'ticket-mismatch'
  /** Less than `sendGuardSec` left to `validUntil` (T-29). */
  | 'send-guard'
  /** The amount to send is below `order.minReceived`. */
  | 'below-min-received'
  /** The destination router already has a fill for the order (T-27). */
  | 'already-filled'
  /** `eth_estimateGas` reverted: the router or the token would refuse it. */
  | 'reverted'
  /** The router could not be approved for the output asset. */
  | 'allowance'
  /** Priced above `maxFeePerGasWei`. */
  | 'fee-ceiling'
  /** BUG-1528, a Canton output: its registry factory cannot be pinned, or its transfer fails the node check — for every order of the route. */
  | 'output-unservable';
