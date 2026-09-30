/**
 * The one seam everything in this package goes through.
 *
 * The client does not know how you authenticate — a user JWT, an app-session
 * grant, a device-flow token — so it does not try. You hand it a `request`
 * that adds whatever your credential is; the client adds the JSON headers, the
 * base URL and one error type. Nothing here holds a key or signs anything.
 */
import { SDK_ERROR_CODES, type SdkErrorCode } from './sdk-error-codes';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Gateway root, e.g. https://api.cancore.io */
  baseUrl: string;
  /** Adds the credential. Gets the absolute URL and the init the client built. */
  request?: FetchLike;
  /** Injected for tests and non-browser hosts; defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(SDK_ERROR_CODES);

/**
 * The refusal code of a response body, or undefined: `errorCode`, else `code` (a
 * gateway older than the registry sends only `code`). A code this client does
 * not know (a newer gateway) is undefined too. Total: never throws, never logs.
 */
export function sdkErrorCodeOf(body: unknown): SdkErrorCode | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { errorCode, code } = body as { errorCode?: unknown; code?: unknown };
  const raw = typeof errorCode === 'string' && errorCode !== '' ? errorCode : code;
  return typeof raw === 'string' && KNOWN_CODES.has(raw) ? (raw as SdkErrorCode) : undefined;
}

/** A non-2xx answer, with the server's own message kept intact. */
export class CancoreApiError extends Error {
  /** The registry code the gateway refused with; undefined when the body carries none this client knows. */
  readonly errorCode?: SdkErrorCode;

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    /** The response body, parsed when it was JSON, raw text otherwise. */
    readonly body: unknown,
  ) {
    super(`${method} ${path} → ${status}${messageOf(body)}`);
    this.name = 'CancoreApiError';
    this.errorCode = sdkErrorCodeOf(body);
  }
}

export function isSdkError<C extends SdkErrorCode>(e: unknown, code: C): e is CancoreApiError & { errorCode: C } {
  return e instanceof CancoreApiError && e.errorCode === code;
}

function messageOf(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    return `: ${Array.isArray(m) ? m.join('; ') : String(m)}`;
  }
  return typeof body === 'string' && body ? `: ${body.slice(0, 200)}` : '';
}

/** Query values: anything scalar; `undefined` means "leave it out". */
export type QueryValue = string | number | boolean | undefined;

export interface Http {
  /** `query` is any object of scalar fields — an interface, not only a Record. */
  get<T>(path: string, query?: object): Promise<T>;
  /** `headers` rides on this one request only, e.g. the captcha token a sign-up carries. */
  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
}

export function createHttp({ baseUrl, request, fetchImpl }: ClientOptions): Http {
  const root = baseUrl.replace(/\/+$/, '');
  const send: FetchLike = request ?? fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const res = await send(`${root}${path}`, init);
    const text = await res.text();
    const parsed: unknown = text ? tryJson(text) : undefined;
    if (!res.ok) throw new CancoreApiError(res.status, method, path, parsed);
    return parsed as T;
  }

  return {
    get: (path, query) => call('GET', path + queryString(query)),
    post: (path, body, headers) => call('POST', path, body, headers),
  };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function queryString(query?: object): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Record<string, QueryValue>)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}
