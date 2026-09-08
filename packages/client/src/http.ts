/**
 * The one seam everything in this package goes through.
 *
 * The client does not know how you authenticate — a user JWT, an app-session
 * grant, a device-flow token — so it does not try. You hand it a `request`
 * that adds whatever your credential is; the client adds the JSON headers, the
 * base URL and one error type. Nothing here holds a key or signs anything.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Gateway root, e.g. https://api.cancore.io */
  baseUrl: string;
  /** Adds the credential. Gets the absolute URL and the init the client built. */
  request?: FetchLike;
  /** Injected for tests and non-browser hosts; defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
}

/** A non-2xx answer, with the server's own message kept intact. */
export class CancoreApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    /** The response body, parsed when it was JSON, raw text otherwise. */
    readonly body: unknown,
  ) {
    super(`${method} ${path} → ${status}${messageOf(body)}`);
    this.name = 'CancoreApiError';
  }
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
  post<T>(path: string, body?: unknown): Promise<T>;
}

export function createHttp({ baseUrl, request, fetchImpl }: ClientOptions): Http {
  const root = baseUrl.replace(/\/+$/, '');
  const send: FetchLike = request ?? fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
    post: (path, body) => call('POST', path, body),
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
