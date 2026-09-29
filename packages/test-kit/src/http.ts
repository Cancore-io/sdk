import type { IncomingMessage, ServerResponse } from 'node:http';

/** The largest REST/control body and WebSocket frame the mock takes; every protocol message is far smaller. */
export const MAX_BODY_BYTES = 64 * 1024;

export class MalformedBodyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The request body as JSON; an empty body is `{}`. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Drain an oversized body instead of breaking out: leaving the loop early destroys the socket the 413 goes out on.
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size <= MAX_BODY_BYTES) chunks.push(c as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new MalformedBodyError(`the body exceeds ${MAX_BODY_BYTES} bytes`, 413);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new MalformedBodyError('the body is not a JSON object');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
