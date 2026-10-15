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
