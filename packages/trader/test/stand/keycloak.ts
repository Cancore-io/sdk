/**
 * A bearer token of a stand Keycloak user, fresh per call (a token lives minutes, a run longer): a password grant
 * through the gateway's own client (CAN-2380 admits it). `user` is STAND_USER_* (the stand user), `admin` is
 * STAND_ADMIN_* (Cancore staff, the ADMIN role); Cancore-io/meta docs/runbooks/intent-stand.md.
 */
import { env } from './canton-ledger';

const LOGINS = {
  user: { name: 'STAND_USER_NAME', password: 'STAND_USER_PASSWORD' },
  admin: { name: 'STAND_ADMIN_NAME', password: 'STAND_ADMIN_PASSWORD' },
} as const;

export async function standToken(who: keyof typeof LOGINS): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'password',
    client_id: env('STAND_USER_CLIENT_ID'),
    client_secret: env('STAND_USER_CLIENT_SECRET'),
    username: env(LOGINS[who].name),
    password: env(LOGINS[who].password),
    scope: 'openid',
  });
  const response = await fetch(env('STAND_USER_TOKEN_URL'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) throw new Error(`stand ${who} login: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}
