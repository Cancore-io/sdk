# @cancore/test-kit

A mock Cancore **filler gateway** for the CI of a taker: filler protocol v1
(`@cancore/contracts` 0.2.x) over WebSocket `/v1` and REST, every server
message signed, a virtual clock the test moves, failure modes switched from the
test, and a harness that checks the taker reacted as the protocol requires.

> **TEST ONLY.** Every key of the mock is `keccak256("cancore:test-kit:<role>:v1")`
> — public, printed in the source. Never fund those addresses, never register
> them on a real router or gateway. A taker under test trusts
> `TEST_KEYS.gateway.address` and `TEST_KEYS.ticketSigner.address` in place of
> `FILLER_GATEWAYS` from `@cancore/contracts`, which never carries test keys.

## One command

```sh
npx @cancore/test-kit mock-gateway --port 8787 --control 8788
# {"event":"ready","url":"ws://127.0.0.1:8787/v1","http":"http://127.0.0.1:8787","control":"http://127.0.0.1:8788"}
```

`--port 0 --control 0` picks free ports; the ready line says which. Options:
`--host`, `--clock frozen|real` (default frozen at the fixture's t0),
`--clock-base <ms>`, `--accept-by-ms 3000`, `--issue-delay-ms 3000`,
`--heartbeat-ms 15000`, `--heartbeat-misses 3`, `--min-ticket-ttl-s 60`,
`--filler <id>:<quoteKey>:<fillerAddress>` (repeatable). Docker:
`docker build -t cancore-mock-gateway packages/test-kit` from a checkout with the
package tarball, then `docker run -p 8787:8787 -p 8788:8788 cancore-mock-gateway`.

## From a test

```ts
import { startMockGateway, TEST_KEYS, assertTakerReaction } from '@cancore/test-kit';

const gw = await startMockGateway({ port: 0, controlPort: 0 });
gw.scenario('LATE_ISSUED');
// … connect the taker to gw.url, log in as acme-markets (TEST_KEYS.acmeQuote) …
gw.offer('acme-markets');
gw.advance(3_000 + 3_000 + 1); // past acceptBy + δ_issue: the late ticket.issued goes out
gw.assertTakerReaction('LATE_ISSUED'); // throws unless the taker declined TICKET_ISSUED_LATE and sent no receipt
await gw.close();
```

The same over HTTP, for a taker in another language — control port `/__mock/*`:

| Route | |
|---|---|
| `GET /__mock/health` | `{ok, now, mode, config}` |
| `GET\|POST /__mock/scenario` `{mode}` | read / switch; an unknown mode is `400 {allowed: […]}` |
| `POST /__mock/reset` | HAPPY, clock back to base, no state, sockets closed |
| `GET\|POST /__mock/clock` `{advanceMs}` | read / move the virtual clock; due work runs at its own time. `advanceMs` is a JSON number, a non-negative integer; anything else is `400` |
| `POST /__mock/rfq` `{fillerIds?, windowCloseAt?, quoteTtlMs?}` | `quote.request` to connected takers; at `windowCloseAt` the draw and the offer |
| `POST /__mock/offer` `{fillerId}` | the fixture order's next attempt, offered to that taker; once the clock leaves no room for a legal ticket on it (`fillDeadline − 1 − now < MIN_TICKET_TTL`), the fixture order opened now |
| `POST /__mock/drop` `{fillerId?}` | close sockets |
| `GET /__mock/log` | every frame both ways, WS and REST: the input of `assertTakerReaction` |
| `GET /__mock/fillers`, `GET /__mock/keys` | registered takers; the TEST keys |

## Scenarios

`MODES`, and what `TAKER_EXPECTATIONS` requires of the taker:

| Mode | The mock | The taker |
|---|---|---|
| `HAPPY` | the protocol | intent, then receipt |
| `LATE_ISSUED` | `ticket.issued` at acceptBy + δ_issue + 1 ms | `ticket.decline {TICKET_ISSUED_LATE}`, no receipt |
| `FOREIGN_TICKET_SIG` | `ticketSig` by a key outside `ticketSigners` | `TICKET_SIGNER_UNKNOWN` |
| `FIELD_MISMATCH` | ticket `validUntil` ≠ the intent | `TICKET_MISMATCH` |
| `SHORT_TTL` | `validUntil − validFrom < MIN_TICKET_TTL` | `TICKET_TTL_TOO_SHORT` |
| `BEYOND_DEADLINE` | `validUntil = order.fillDeadline` | `TICKET_BEYOND_DEADLINE` |
| `WRONG_DRAW` | offer to a taker the published draw does not name | `DRAW_MISMATCH` |
| `BAD_GATEWAY_SIG` | the offer signed by a foreign key | drop it: no intent |
| `UNSUPPORTED_VERSION` | `error UNSUPPORTED_VERSION` on login, socket closed | no reconnect loop |
| `DROP_CONNECTION` | socket closed right after the offer | REST login, `GET /v1/filler/tickets`, `POST …/intent` before acceptBy |
| `NO_ISSUED` | no `ticket.issued`; attempt + 1 offered after acceptBy + δ_issue | nothing: no receipt, no fill |
| `CANTON_DESTINATION` | `ticket.issued {form: "canton", deliveryOrderCid}` | `ticket.decline {OTHER, detail "O-5"}` |
| `UNKNOWN_S2F_TYPE` | a signed `future.info` and an offer with field `x` | ignore both extras, act on the offer |

Out of the mock (need a chain or a participant): `ESCROW_NOT_OPEN`,
`ESCROW_MISMATCH`, `PROOF_WINDOW_TOO_SHORT`, `SKEW_MARGIN_TOO_SHORT`.

## What the mock is

- Every S→F frame: `fillerId` (except `auth.challenge` and pre-auth `error`),
  `sentAt` (ms), `sig` = gateway key over `GatewayMessage{keccak256(JCS(frame without sig))}`.
  Records (`GET /v1/draws/…`) are signed the same way, without `fillerId`/`sentAt`.
- F→S frames are checked against the protocol JSON Schemas of
  `@cancore/contracts`; a bad one is `error BAD_REQUEST` naming the field.
- The fixture order is the EVM-source vector of `@cancore/contracts`
  (`spec/typed-data/Order.json`); at the default clock its attempt-0 draw is
  the contracts draw vector, on a real drand quicknet round. In `--clock real`
  mode drand rounds are synthetic (the BLS check of a verifier fails).
- Heartbeat: a ping counts as missed only if the taker had a chance to answer:
  pings sent inside one jump of the virtual clock are not held against it.
  Several jumps in a row are not one jump: each jump of `≥ heartbeatMs` sends
  a ping, and the next jump counts the previous ping missed unless the pong
  already arrived. A test that fires such jumps back to back (a synchronous
  loop of `gw.advance(20_000)`, or HTTP advances faster than the taker's pong
  round trip) gets the socket closed after `heartbeatMisses` of them. Advance
  in one call, await a pong between jumps, or start the mock with a
  `--heartbeat-ms` larger than the total the test moves the clock.
- A ticket is offered only if it can satisfy S-1 and S-3; `NO_ISSUED` stops
  re-offering an order once no legal ticket fits before its `fillDeadline`.
- Malformed input is answered, never fatal: a signature with `r` or `s` out of
  range is `BAD_SIGNATURE` (422), a number that passes the schema but not its
  EIP-712 width (a 20-digit `uint64`) is `BAD_REQUEST` (400), an unexpected
  failure `INTERNAL` (500) — on the socket or the REST call that caused it.
- A REST/control body or a WebSocket frame over 64 KiB is refused: `413`
  (REST, control), close code `1009` (WebSocket).
- An unknown REST route, draw or epoch is `404 UNKNOWN_REQUEST`: v1 has no
  NOT_FOUND code, and this is the one whose status is 404 "no such thing".
- `fill.reported` stands in for the chain: a fill reported in a second
  ≤ `validUntil` expires `FILLED` (then `order.settled`), else `NO_SHOW` with a
  receipt, `NO_SHOW_UNCONFIRMED` without.
- Not implemented: `quote.reconfirm`, `penalty.applied`, stake bindings, stats,
  penalties list, pagination (`nextCursor` is always null), the band/outlier
  filter (every counted quote is a candidate).
