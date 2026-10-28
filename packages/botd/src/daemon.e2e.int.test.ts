// The daemon end-to-end suite in the int lane, the one CI runs (`npm run test:int`; CAN-2934 keeps `npm test` out of
// CI). It is an integration suite — real keystore, audit log, state file, risk gate, engine and verifying signer, over
// both sockets, against a fake API — and it carries the @happy/@negative/@edge cases of CAN-2833, CAN-2834 and CAN-2836.
import './daemon.e2e.test';
