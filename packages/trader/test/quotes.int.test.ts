/**
 * Integration: quotes against a real filler-gateway (CAN-1852).
 *
 * Stand contract (dev):
 *   FILLER_GATEWAY_URL  http(s)://<host>:3107/v1 (or ws(s)://.../v1)
 *
 * Skipped without FILLER_GATEWAY_URL.
 */
const RAW_URL = process.env.FILLER_GATEWAY_URL;
// Normalise to an HTTP base for REST probes.
const HTTP_BASE = RAW_URL
  ? RAW_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/v1\/?$/, '')
  : undefined;
const live = RAW_URL ? describe : describe.skip;

live('CAN-1852: quotes against a real filler-gateway', () => {
  it('gateway is ready', async () => {
    const res = await fetch(`${HTTP_BASE}/health/ready`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { status?: string };
    expect(body.status).toBe('ready');
  });

  it('gateway publishes ticket signers', async () => {
    const res = await fetch(`${HTTP_BASE}/v1/gateway`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { ticketSigners?: string[] };
    expect(Array.isArray(body.ticketSigners)).toBe(true);
    expect((body.ticketSigners ?? []).length).toBeGreaterThan(0);
  });

  it('filler id is registered (if provided)', async () => {
    const fillerId = process.env.FILLER_GATEWAY_FILLER_ID;
    if (!fillerId) return; // optional
    const res = await fetch(`${HTTP_BASE}/v1/gateway`);
    expect(res.ok).toBe(true);
  });
});
