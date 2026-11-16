/**
 * Cancore staff on the intent stand: STAND_ADMIN_* is a Keycloak user of the stand with the ADMIN role
 * (Cancore-io/meta docs/runbooks/intent-stand.md), logged in through the same client as the stand user. trading
 * serves the admin routes; the gateway is tried when trading does not know them.
 */
import { env } from './canton-ledger';

export const ADMIN_KEYS = ['STAND_ADMIN_NAME', 'STAND_ADMIN_PASSWORD', 'STAND_USER_TOKEN_URL', 'STAND_USER_CLIENT_ID', 'STAND_USER_CLIENT_SECRET', 'TRADING_URL'] as const;

async function adminToken(): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'password',
    client_id: env('STAND_USER_CLIENT_ID'),
    client_secret: env('STAND_USER_CLIENT_SECRET'),
    username: env('STAND_ADMIN_NAME'),
    password: env('STAND_ADMIN_PASSWORD'),
    scope: 'openid',
  });
  const response = await fetch(env('STAND_USER_TOKEN_URL'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) throw new Error(`stand admin login: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** A staff request to Cancore: the parsed answer, or an error naming the status and the body. */
export async function adminApi<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const bases = [process.env.TRADING_URL, process.env.GATEWAY_URL].filter((u): u is string => !!u);
  const token = await adminToken();
  let last = '';
  for (const base of bases) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as T;
    last = `${method} ${base}${path}: ${response.status} ${text.slice(0, 500)}`;
    if (response.status !== 401 && response.status !== 404) break;
  }
  throw new Error(last);
}
