# @cancore/botd

The core of a self-custody trading daemon for Cancore: an encrypted keystore for one bot
account's key, a signer that recomputes the prepared-transaction hash before it signs, owner-set
limits behind a default-deny risk gate, and a hash-chained audit log.

Release candidate. This package currently ships the library layer only; the daemon, its CLI, the
unix-socket API and the strategies land in the next release.

```bash
npm install @cancore/botd
```

```ts
import { createKeystore, parseLimits, check, openAuditLog } from '@cancore/botd';
```

`@cancore/botd/protocol` exports the command and response schemas alone, with no key or signer code.
