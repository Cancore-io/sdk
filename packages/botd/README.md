# `@cancore/botd`

```sh
npm install @cancore/botd
```

A self-custody trading daemon for Cancore. **Work in progress (CAN-2710): every module is a stub.**

- `cancore-botd` — the daemon: keystore, default-deny risk gate, hash-chained audit log, local unix-socket JSON-RPC 2.0 API.
- `cancore-bot` — the owner CLI: init, unlock, limits, resume.
- `@cancore/botd/protocol` — the command and response schemas only, with no key-handling code:

```ts
import { parseRequest, RISK_CLASS } from '@cancore/botd/protocol';
```

## Strategies

`strategy.start` with `kind: "grid"` or `"dca"`; the config schemas are `gridConfig` / `dcaConfig` in `src/riskgate.ts`.

- **grid** places `amountPerLevel` on the configured side at `levels` prices spaced evenly from `lowerPrice` to `upperPrice`. A filled buy is sold one level up, a filled sell bought back one level down.
- **dca** places `amountPerOrder` at the reference price every `intervalSeconds`, `maxOrders` in total.

Every strategy order is an `order.make` through the same risk gate, audit log and engine as an agent's. A refusal stops the strategy (`status: "denied"`, `reason` in `status`); the daemon keeps running. Strategy state lives in the state file, and running strategies resume on unlock without placing a level (grid) or seq (dca) twice. `pause` and `strategy.stop` stop the loop and cancel the strategy's resting orders; a strategy order cancelled by hand is placed again.

**Rate limit.** The platform accepts 5 new orders an hour per user. Each strategy has an `ordersPerHour` budget (default 5): once spent it waits with `status: "rate_limited"` instead of sending orders the API would refuse. The platform limit is per user, not per strategy, so keep the sum of budgets of concurrent strategies at or under it.
