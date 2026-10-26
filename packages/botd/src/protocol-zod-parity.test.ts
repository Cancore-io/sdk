import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ERROR, METHODS, parseRequest } from './protocol/index';

// The fixture's outcomes were recorded on zod 3.25.76, before the bump to zod 4, and the migration is judged against
// them. Re-record only with PROTOCOL_PARITY_RECORD=1, and say in the commit why each changed outcome is acceptable.
const FIXTURE = join(__dirname, '__fixtures__', 'protocol-parity.json');
const RECORD = process.env.PROTOCOL_PARITY_RECORD === '1';

interface Entry {
  name: string;
  input: unknown;
  outcome?: 'success' | 'failure';
  value?: unknown;
  code?: number;
}

function outcomeOf(input: unknown): Pick<Entry, 'outcome' | 'value' | 'code'> {
  const parsed = parseRequest(input);
  return parsed.ok ? { outcome: 'success', value: parsed.request.params } : { outcome: 'failure', code: parsed.error.code };
}

const methodOf = (input: unknown) => (input as { method?: unknown } | null)?.method;

const corpus = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Entry[];

if (RECORD) {
  test('re-records the outcomes into the fixture', () => {
    const recorded = corpus.map(({ name, input }) => ({ name, input, ...outcomeOf(input) }));
    writeFileSync(FIXTURE, `[\n${recorded.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n`);
  });
} else {
  describe('protocol parse outcomes against the zod 3 baseline (CAN-3083)', () => {
    test('every METHODS entry has a valid and an INVALID_PARAMS input in the corpus', () => {
      for (const method of METHODS) {
        const own = corpus.filter((entry) => methodOf(entry.input) === method);
        expect({
          method,
          valid: own.some((entry) => entry.outcome === 'success'),
          rejected: own.some((entry) => entry.outcome === 'failure' && entry.code === ERROR.INVALID_PARAMS),
        }).toEqual({ method, valid: true, rejected: true });
      }
    });

    test('corpus names are unique', () => {
      expect(new Set(corpus.map((entry) => entry.name)).size).toBe(corpus.length);
    });

    test.each(corpus.map((entry): [string, Entry] => [entry.name, entry]))('%s', (_name, entry) => {
      expect(outcomeOf(entry.input)).toEqual({ outcome: entry.outcome, value: entry.value, code: entry.code });
    });
  });

  describe('CAN-3083 scenario outlines', () => {
    const auditTail = (params: unknown) => parseRequest({ jsonrpc: '2.0', id: 1, method: 'audit.tail', params });
    for (const [params, n] of [[{}, 50], [{ n: 1 }, 1], [{ n: 1000 }, 1000]] as const) {
      test(`audit.tail ${JSON.stringify(params)} succeeds with n = ${n}`, () => {
        expect(auditTail(params)).toMatchObject({ ok: true, request: { params: { n } } });
      });
    }
    for (const params of [{ n: 0 }, { n: 1001 }]) {
      test(`audit.tail ${JSON.stringify(params)} fails with INVALID_PARAMS`, () => {
        expect(auditTail(params)).toMatchObject({ ok: false, error: { code: ERROR.INVALID_PARAMS } });
      });
    }
    for (const limits of ['unlimited', 42, true, null, [1, 2]]) {
      test(`limits.set with limits ${JSON.stringify(limits)} fails with INVALID_PARAMS`, () => {
        const result = parseRequest({ jsonrpc: '2.0', id: 1, method: 'limits.set', params: { limits } });
        expect(result).toMatchObject({ ok: false, error: { code: ERROR.INVALID_PARAMS } });
      });
    }
  });
}
