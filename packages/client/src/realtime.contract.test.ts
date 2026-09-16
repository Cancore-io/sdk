import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORDER_UPDATED_EVENT, waitForOrder } from './realtime';
import type { Order } from './swap';

/**
 * The realtime entry reads a feed that has no OpenAPI document — a Socket.IO
 * event name and the fields of its payload — so what would otherwise be
 * remembered is written down in `contract/realtime-events.contract.json`, with
 * the backend file:line each fact came from, and checked here.
 *
 * Two of the three checks have teeth beyond the file itself: the event name is
 * the module's own constant, not a copy, and the payload fields are read off a
 * proxy while `waitForOrder` runs rather than listed by hand. The third holds
 * those fields against `spec/openapi.json`, which is the gateway's own document
 * — `order:updated` carries an OrderResponseDto, so the day a field this client
 * reads leaves that DTO, this goes red.
 */
interface Contract {
  namespace: string;
  events: Array<{ name: string; payload: { fieldsRead: string[] } }>;
}
const contract = JSON.parse(
  readFileSync(join(__dirname, '..', 'contract', 'realtime-events.contract.json'), 'utf8'),
) as Contract;

interface Spec {
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
}
const spec = JSON.parse(readFileSync(join(__dirname, '..', 'spec', 'openapi.json'), 'utf8')) as Spec;

/** Which payload fields the client touches — recorded while it runs, not listed. */
async function fieldsTheClientReads(): Promise<string[]> {
  const read = new Set<string>();
  let handler: ((payload: unknown) => void) | undefined;
  const socket = {
    on: (_event: string, fn: (payload: unknown) => void) => (handler = fn),
    off: () => {},
  };

  const waiting = waitForOrder(socket, 'o1');
  handler?.(
    new Proxy({ id: 'o1', status: 'completed' } as unknown as Order, {
      get(target, key, receiver) {
        // `then` is the promise machinery probing the resolved value for a
        // thenable, not a field this client read.
        if (typeof key === 'string' && key !== 'then') read.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    }),
  );
  await waiting;
  return [...read].sort();
}

test('the contract names the events this module subscribes to', () => {
  expect(contract.events.map((event) => event.name)).toEqual([ORDER_UPDATED_EVENT]);
});

test('every payload field the client reads is one the contract declares', async () => {
  const read = await fieldsTheClientReads();
  expect(read.length).toBeGreaterThan(0); // a vacuous pass would be worse than a failure
  const declared = contract.events[0]?.payload.fieldsRead ?? [];
  expect(read.filter((field) => !declared.includes(field))).toEqual([]);
});

test('every payload field the contract declares is a field OrderResponseDto has', () => {
  const known = Object.keys(spec.components.schemas.OrderResponseDto?.properties ?? {});
  expect(known.length).toBeGreaterThan(0);
  const declared = contract.events.flatMap((event) => event.payload.fieldsRead);
  expect(declared.filter((field) => !known.includes(field))).toEqual([]);
});
