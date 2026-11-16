/**
 * The stand's Canton JSON API Ledger API v2, as the stand specs read it independently of the SDK and of
 * filler-gateway: one login and one active-contracts read, so a change of the stand's token scope or of the
 * ACS request shape is fixed once for every spec.
 */
/** A stand variable the spec cannot run without; its absence fails naming it. */
export const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`intent-stand env: ${name} is not set (Cancore-io/meta docs/runbooks/intent-stand.md)`);
  return value;
};

/**
 * A bearer token of the stand's Canton JSON API (client credentials). The stand's Keycloak issues ledger tokens
 * under `openid` (as its own scripts ask); `CANTON_TOKEN_SCOPE` names another scope where the issuer wants one.
 */
export async function cantonToken(): Promise<string> {
  const scope = process.env.CANTON_TOKEN_SCOPE || 'openid';
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: env('CANTON_CLIENT_ID'), client_secret: env('CANTON_CLIENT_SECRET'), scope });
  const response = await fetch(env('CANTON_TOKEN_URL'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) throw new Error(`Canton JSON API login: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** A Ledger API v2 call: GET without a body, POST with one. Throws on any refusal. */
export async function ledger<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(`${env('CANTON_JSON_API_URL').replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return (await response.json()) as T;
}

/** A filter names a template by package name (`#name:Module:Entity`); a package id is refused there. */
export type IdentifierFilter =
  | { TemplateFilter: { value: { templateId: string; includeCreatedEventBlob: boolean } } }
  | { InterfaceFilter: { value: { interfaceId: string; includeInterfaceView: boolean; includeCreatedEventBlob: boolean } } };

export interface CreatedEvent {
  contractId: string;
  createArgument?: Record<string, unknown>;
  interfaceViews?: Array<{ viewValue?: unknown }>;
}

/** The created events of the contracts `party` sees under `filter`, active at the ledger end. */
export async function activeContracts(party: string, filter: IdentifierFilter, token: string): Promise<CreatedEvent[]> {
  const { offset } = await ledger<{ offset: number }>('/v2/state/ledger-end', token);
  type Row = { contractEntry?: { JsActiveContract?: { createdEvent?: CreatedEvent } } };
  // eventFormat alone: the participant refuses it beside the older top-level verbose/filter.
  const rows = await ledger<Row[]>('/v2/state/active-contracts', token, {
    activeAtOffset: offset,
    eventFormat: { verbose: true, filtersByParty: { [party]: { cumulative: [{ identifierFilter: filter }] } } },
  });
  return rows.flatMap((r) => (r.contractEntry?.JsActiveContract?.createdEvent ? [r.contractEntry.JsActiveContract.createdEvent] : []));
}

/** The ledger end: the offset a later `exercisedAfter` reads from. */
export async function ledgerEnd(token: string): Promise<number> {
  return (await ledger<{ offset: number }>('/v2/state/ledger-end', token)).offset;
}

export interface ExercisedEvent {
  contractId: string;
  templateId: string;
  choice: string;
  actingParties?: string[];
}

/**
 * Every choice exercised in the transactions `party` sees after `after` up to the ledger end, in the
 * choice-level shape (LEDGER_EFFECTS): a consuming choice nested under another is counted too. An answer can be
 * short of the end (the HTTP list returns what it gathered in its wait), so it is read page by page from the
 * highest offset seen; a page with no offset at all ends the read, which can only under-count.
 */
export async function exercisedAfter(party: string, after: number, token: string): Promise<ExercisedEvent[]> {
  const end = await ledgerEnd(token);
  // One key per item: Transaction, Reassignment or OffsetCheckpoint; each carries its offset.
  type Item = { update?: Record<string, { value?: { offset?: number; events?: Array<{ ExercisedEvent?: ExercisedEvent }> } } | undefined> };
  const wildcard = { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } };
  const exercised: ExercisedEvent[] = [];
  for (let from = after; from < end; ) {
    const items = await ledger<Item[]>('/v2/updates?limit=200', token, {
      beginExclusive: from,
      endInclusive: end,
      updateFormat: { includeTransactions: { transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS', eventFormat: { verbose: true, filtersByParty: { [party]: { cumulative: [wildcard] } } } } },
    });
    const offsets = items.flatMap((i) => Object.values(i.update ?? {}).map((u) => u?.value?.offset)).filter((o): o is number => typeof o === 'number');
    if (offsets.length === 0) break;
    for (const item of items) for (const event of item.update?.Transaction?.value?.events ?? []) if (event.ExercisedEvent) exercised.push(event.ExercisedEvent);
    from = Math.max(...offsets);
  }
  return exercised;
}
