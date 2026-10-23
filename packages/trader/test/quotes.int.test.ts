/**
 * Integration: quotes against a real filler-gateway (CAN-1852).
 *
 * Pending: full scenario from the ticket (quote.reconfirm, replacement, ack)
 * requires a live filler-gateway stand. Skipped unless FILLER_GATEWAY_URL is set.
 *
 *   FILLER_GATEWAY_URL=http://127.0.0.1:... npm run test:int -- quotes
 */
const GATEWAY_URL = process.env.FILLER_GATEWAY_URL;
const live = GATEWAY_URL ? describe : describe.skip;

live('CAN-1852: quotes against a real filler-gateway', () => {
  it('smoke: gateway URL is provided', () => {
    expect(GATEWAY_URL).toBeTruthy();
  });
});
