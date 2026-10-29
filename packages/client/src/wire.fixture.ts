/** What the gateway sends on the wire, for the client's specs (unit and int alike). */

/** One prepared transaction as `POST /wallet/operations/prepare` lists it: a leg of the operation. */
export const wireLeg = (t: { kind: string; preparedTransactionHash: string; preparedTransaction: string }, legId: string) =>
  ({ legId, hash: t.preparedTransactionHash, kind: t.kind, preparedTransaction: t.preparedTransaction });

/** The gateway's refusal body: its status and message and, when it has one, its code under both names. */
export const refusalBody = (status: number, message: string, errorCode?: string) =>
  ({ statusCode: status, message, ...(errorCode ? { errorCode, code: errorCode } : {}) });
