/**
 * Signing in as a self-custody account, from a program.
 *
 * The account's own Ed25519 key is its login: the API hands out a challenge,
 * the key signs it, and the answer is a JWT. There is no password to keep and
 * no browser to drive, which is what a partner's trading service needs. The
 * session then keeps that JWT alive by itself — refreshed ahead of expiry, and
 * re-issued by a fresh signature when the refresh token is gone or the API
 * answers 401 — so every request a caller makes through `request` is signed in.
 *
 * The key never reaches this module in any other form than a signer: pass the
 * provider `@cancore/wallet`'s `providerFromMnemonic` returns, or anything with
 * the same shape.
 */
import { createHttp, type FetchLike } from './http';
import { refusalOf } from './refusal';

/**
 * What the session needs from a key. `@cancore/wallet`'s signing provider fits
 * as it is; so does any other holder of the key with the same three methods.
 */
export interface KeySigner {
  /** Hex Ed25519 public key — the account's identity at sign-in. */
  public_key: string;
  /** Raw bytes as a binary string (one char per byte) → lowercase hex signature. */
  signMessage(message: string): Promise<string>;
  /** The shape-checked path for a login challenge; preferred over `signMessage` when present. */
  signChallenge?(challenge: string): Promise<string>;
  /** Base64 32-byte prepared-transaction hash → base64 signature. */
  signPreparedHash?(preparedTransactionHashB64: string): Promise<string>;
}

export interface SessionOptions {
  /** Gateway root, e.g. https://api.cancore.io */
  baseUrl: string;
  signer: KeySigner;
  /** Injected for tests and non-browser hosts; defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** `UserResponseDto`, the fields a program acts on. */
export interface AccountUser {
  id: string;
  /** Null until the account's party exists — see `onboard`. */
  partyId: string | null;
  partyName: string;
  roles: string[];
  status: string;
  signingMethod?: string | null;
  email?: string | null;
  walletPublicKey?: string | null;
}

/** `AuthResponseDto` */
interface AuthResponse {
  token: string;
  refreshToken?: string;
  user: AccountUser;
}

export interface RegisterInput {
  /**
   * An invite code (`XXXX-XXXX-XXXX`), redeemed by the sign-up request itself.
   * A code minted with a role — `partner-bot` for a partner — grants that role,
   * and an unused code stands in for the stand's captcha. A sign-up that comes
   * back `FAILED` is retried with the same key and the same code: the API knows
   * the code as this key's and grants the role again rather than refusing it.
   */
  inviteCode?: string;
  /** Optional for a self-custody account. */
  email?: string;
  /** Shown as the account's name and used as the party hint. Default: derived from the public key. */
  partyName?: string;
  /** The stand's sign-up captcha token, when it requires one. */
  captchaToken?: string;
}

export interface Session {
  /** Hex public key the session signs in with. */
  readonly publicKey: string;
  /**
   * The authenticated transport: bearer added, renewed before it expires, and
   * one fresh sign-in when the API answers 401. Hand it to any client in this
   * package as its `request`.
   */
  readonly request: FetchLike;
  /** Sign in with the key. The account must exist. */
  login(): Promise<AccountUser>;
  /**
   * Create the account for this key and sign in, redeeming `inviteCode` in the
   * same request. The account's party is created separately (`onboard`),
   * because it is the key — not the API — that has to sign it into existence.
   */
  register(input?: RegisterInput): Promise<AccountUser>;
}

/** Renew this long before `exp`, so a request never leaves with a token that dies in flight. */
const RENEW_AHEAD_MS = 60_000;

export function createSession({ baseUrl, signer, fetchImpl, now = Date.now }: SessionOptions): Session {
  const send: FetchLike = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const anonymous = createHttp({ baseUrl, request: send });
  const publicKey = signer.public_key;

  let token: string | null = null;
  let refreshToken: string | null = null;
  let renewing: Promise<unknown> | null = null;

  const signChallenge = (challenge: string) =>
    signer.signChallenge ? signer.signChallenge(challenge) : signer.signMessage(challenge);

  function adopt(auth: AuthResponse): AccountUser {
    token = auth.token;
    refreshToken = auth.refreshToken ?? null;
    return auth.user;
  }

  async function login(): Promise<AccountUser> {
    const { challenge } = await anonymous.post<{ challenge: string }>('/auth/challenge', { publicKey });
    return adopt(
      await anonymous.post<AuthResponse>('/auth/login-signature', {
        publicKey,
        signature: await signChallenge(challenge),
        challenge,
      }),
    );
  }

  /** A refresh when there is a refresh token to spend; a fresh signature otherwise, or when it fails. */
  async function renew(): Promise<void> {
    if (refreshToken) {
      try {
        const next = await anonymous.post<{ token: string; refreshToken?: string }>('/auth/refresh', { refreshToken });
        token = next.token;
        refreshToken = next.refreshToken ?? refreshToken;
        return;
      } catch {
        // A spent or revoked refresh token — the key can always sign in again.
      }
    }
    await login();
  }

  /** One renewal at a time: concurrent requests that all see a stale token wait on the same one. */
  function once(fn: () => Promise<unknown>): Promise<unknown> {
    renewing ??= fn().finally(() => {
      renewing = null;
    });
    return renewing;
  }

  const withBearer = (init: RequestInit): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
  });

  const request: FetchLike = async (url, init) => {
    if (!token || expiresWithin(token, RENEW_AHEAD_MS, now())) await once(renew);
    const res = await send(url, withBearer(init));
    if (res.status !== 401) return res;
    // A 401 means the request was not processed, so sending it again is safe:
    // the token was revoked (a migration cutover revokes sessions) or expired
    // early. The refresh token is suspect too — sign in again.
    await once(login);
    return send(url, withBearer(init));
  };

  const authed = createHttp({ baseUrl, request });

  async function signUp({ inviteCode, email, partyName, captchaToken }: RegisterInput): Promise<AccountUser> {
    const { challenge } = await anonymous.post<{ challenge: string }>('/auth/register-challenge', { publicKey });
    return adopt(
      await anonymous.post<AuthResponse>(
        '/auth/register',
        {
          signingMethod: 'passkey',
          publicKey,
          challenge,
          signature: await signChallenge(challenge),
          // The API requires a party name when there is no email to derive one from.
          partyName: partyName ?? `acct-${publicKey.slice(0, 16)}`,
          ...(email ? { email } : {}),
          ...(inviteCode ? { inviteCode } : {}),
        },
        captchaToken ? { 'x-captcha-token': captchaToken } : undefined,
      ),
    );
  }

  async function register(input: RegisterInput = {}): Promise<AccountUser> {
    const { inviteCode } = input;
    try {
      // The code rides on the sign-up itself: the account and the code's role
      // come from one request, and a sign-up retried with the same key and code
      // is recognized as the same one.
      return await signUp(input);
    } catch (err) {
      if (!inviteCode || refusalOf(err) !== 'redeemInviteSeparately') throw err;
    }
    // A gateway whose sign-up does not take the code yet: sign up, then redeem.
    await signUp({ ...input, inviteCode: undefined });
    await authed.post('/auth/redeem-invite', { code: inviteCode });
    // Roles are read from the database on every request, so the redeemed role
    // is live at once — re-read the account to return it.
    return authed.get<AccountUser>('/auth/me');
  }

  return { publicKey, request, login, register };
}

/** Whether a JWT's `exp` falls within `aheadMs` of `nowMs`. An unreadable token is left to the 401 path. */
export function expiresWithin(jwt: string, aheadMs: number, nowMs: number): boolean {
  const payload = jwt.split('.')[1];
  if (!payload) return false;
  try {
    const { exp } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof exp === 'number' && exp * 1000 - aheadMs <= nowMs;
  } catch {
    return false;
  }
}
