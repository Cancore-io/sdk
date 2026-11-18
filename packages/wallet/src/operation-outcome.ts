/** `202 { operationId, status: "pending" }` from submit: the outcome is not known yet and the operation may still commit (CAN-3675). */
export interface PendingSubmitAnswer {
  operationId: string;
  status: 'pending';
}

export type OperationStatus = 'prepared' | 'submitted' | 'committed' | 'rejected' | 'expired_not_committed';

/** What `GET /wallet/operations/{operationId}` answers. */
export interface OperationStatusView {
  operationId: string;
  status: OperationStatus;
  updateId?: string | null;
  reason?: string;
  errorCode?: string;
}

/** The prepared transaction expired without a commit: nothing moved, a new prepare is safe. */
export class OperationNotCommittedError extends Error {
  readonly errorCode = 'EXPIRED_NOT_COMMITTED';
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} expired without being committed`);
    this.name = 'OperationNotCommittedError';
  }
}

/** Polling gave up while the operation was still in flight: it may yet commit, so do not prepare it again. */
export class OperationOutcomeUnknownError extends Error {
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} is still being processed; its outcome is not known yet`);
    this.name = 'OperationOutcomeUnknownError';
  }
}

/** Operation answers that carry their own `status: 'pending'` with HTTP 200 (deferred fees): final results, not a 202. */
const OPERATION_ANSWER_FIELDS = ['errorCode', 'charged', 'feeRef'];

export function isPendingSubmitAnswer(answer: unknown): answer is PendingSubmitAnswer {
  if (typeof answer !== 'object' || answer === null) return false;
  const { status, operationId } = answer as { status?: unknown; operationId?: unknown };
  return (
    status === 'pending' &&
    typeof operationId === 'string' &&
    operationId.length > 0 &&
    !OPERATION_ANSWER_FIELDS.some((field) => field in answer)
  );
}

export interface OutcomePolling {
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Turns a submit answer into its final outcome. A pending answer is never a
 * success: the status is polled until committed or rejected, then the same
 * signatures are submitted once more, which the backend answers by replaying the
 * first outcome (the result, or the coded refusal) without executing again.
 */
export async function settleSubmitAnswer<T>(
  answer: T | PendingSubmitAnswer,
  readStatus: () => Promise<OperationStatusView>,
  replay: () => Promise<T | PendingSubmitAnswer>,
  { intervalMs = 2_000, timeoutMs = 10 * 60_000, sleep = defaultSleep, now = Date.now }: OutcomePolling = {},
): Promise<T> {
  if (!isPendingSubmitAnswer(answer)) return answer;
  const { operationId } = answer;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    const { status } = await readStatus();
    if (status === 'expired_not_committed') throw new OperationNotCommittedError(operationId);
    if (status !== 'committed' && status !== 'rejected') continue;
    const settled = await replay();
    if (!isPendingSubmitAnswer(settled)) return settled;
  }
  throw new OperationOutcomeUnknownError(operationId);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

