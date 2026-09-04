import {
  RpcCode,
  rpcError,
  type CancoreSession,
  type MessageEventLike,
  type PopupLike,
  type WindowLike,
} from './types';

/**
 * The dApp half of the consent ceremony (CAN-776 PR-1, CAN-779).
 *
 * The wallet half lives in `src/hooks/useConnectCeremony.ts`; the two halves
 * are one protocol and the comments there explain why each rule exists. The
 * rules this side owes:
 *
 * - post the handshake **repeatedly**, because the wallet never acknowledges
 *   it: the consent page may navigate away to a login and come back, and an
 *   ack-then-wait dApp would then be waiting for a message nobody will resend;
 * - accept the answer only from the window we opened AND only when the browser
 *   stamped it with the wallet's origin. The token in that message is a bearer
 *   credential; a page that is merely `postMessage`-ing at us is not the wallet;
 * - address every message to the wallet's origin explicitly. `'*'` would hand
 *   the handshake to whatever the popup navigated to.
 */

/** Sent by us, until an answer arrives. */
const CONNECT_REQUEST_TYPE = 'cancore:connect-request';

/** Sent back by the wallet, once, to our verified origin. */
const CONNECT_RESULT_TYPE = 'cancore:connect-result';

const HANDSHAKE_INTERVAL_MS = 400;

/** Matches what the official SDK waits for a remote `connect` to complete. */
const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;

const POPUP_FEATURES = 'popup=yes,width=460,height=760';

export interface CeremonyOptions {
  /** Wallet origin — `https://app-dev.cancore.app`. From the registry entry's `networkHosts`. */
  host: string;
  /** Shown to the user on the consent screen. Display only; the wallet trusts the origin, not this. */
  appName: string;
  /** App-session scopes. `wallet:connect` is added by the wallet when another `wallet:` scope is asked for. */
  scopes: string[];
  win: WindowLike;
}

interface ConnectResult {
  type?: unknown;
  token?: unknown;
  scopes?: unknown;
  expiresAt?: unknown;
  rpcUrl?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/**
 * Runs the ceremony and resolves with the grant.
 *
 * Opens the window **synchronously**, before the first `await` in the caller's
 * chain: PartyLayer drives `connect()` straight off the user's click and a
 * popup opened after an await is a popup the browser blocks.
 */
export function runConnectCeremony(options: CeremonyOptions): Promise<CancoreSession> {
  const origin = new URL(options.host).origin;
  const popup = options.win.open(`${origin}/connect`, 'cancore-connect', POPUP_FEATURES);
  if (!popup) {
    return Promise.reject(
      rpcError(RpcCode.DISCONNECTED, 'The browser blocked the Cancore consent window'),
    );
  }
  return awaitConsent(options, origin, popup);
}

function awaitConsent(
  options: CeremonyOptions,
  origin: string,
  popup: PopupLike,
): Promise<CancoreSession> {
  return new Promise<CancoreSession>((resolve, reject) => {
    const handshake = { type: CONNECT_REQUEST_TYPE, appName: options.appName, scopes: options.scopes };

    const ask = setInterval(() => {
      if (popup.closed) {
        settle(() => reject(rpcError(RpcCode.USER_REJECTED, 'The consent window was closed')));
        return;
      }
      popup.postMessage(handshake, origin);
    }, HANDSHAKE_INTERVAL_MS);

    const expiry = setTimeout(() => {
      popup.close();
      settle(() => reject(rpcError(RpcCode.RESOURCE_UNAVAILABLE, 'The consent window was not answered in time')));
    }, CEREMONY_TIMEOUT_MS);

    function settle(finish: () => void) {
      clearInterval(ask);
      clearTimeout(expiry);
      options.win.removeEventListener('message', onMessage);
      finish();
    }

    function onMessage(event: MessageEventLike) {
      if (event.origin !== origin || event.source !== popup) return;
      const result = event.data as ConnectResult | null;
      if (typeof result !== 'object' || result === null || result.type !== CONNECT_RESULT_TYPE) return;
      const session = readSession(result);
      if (session) {
        settle(() => resolve(session));
        return;
      }
      const code = typeof result.error?.code === 'number' ? result.error.code : RpcCode.USER_REJECTED;
      const message =
        typeof result.error?.message === 'string' ? result.error.message : 'The wallet refused the request';
      settle(() => reject(rpcError(code, message)));
    }

    options.win.addEventListener('message', onMessage);
    popup.postMessage(handshake, origin);
  });
}

/**
 * `rpcUrl` comes from the wallet rather than from a table in this package on
 * purpose: the API host is not the app host on any of our environments, and a
 * copy of that mapping here is a copy that goes stale silently — the failure
 * would be a dApp posting a user's grant at whatever now answers on the old
 * address.
 */
function readSession(result: ConnectResult): CancoreSession | null {
  const { token, rpcUrl, scopes, expiresAt } = result;
  if (typeof token !== 'string' || token.length === 0) return null;
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) return null;
  return {
    token,
    rpcUrl,
    scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    expiresAt: typeof expiresAt === 'string' ? expiresAt : '',
  };
}
