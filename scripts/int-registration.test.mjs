// CAN-3253: every *.int.test.ts has a lane that actually runs it. Without one a suite that skips itself
// "without the stand" is green in `npm run test:int` forever and its regression goes unnoticed.
//
// A suite is registered when one of these holds:
//   - its path is named in .github/workflows/ci.yml (the stand/anvil/deployments jobs pin a suite count);
//   - it is *.stand.int.test.ts (backend sdk-stand-specs.yml picks those up by suffix on the intent stand);
//   - it has no skip path at all, so the check job's `npm run test:int` glob runs it for real;
//   - it is in ALLOWLIST with a ticket, the reason and the date it was measured.
//
//   node --test scripts/int-registration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const ALLOWLIST = {
  'packages/trader/test/canton-source.int.test.ts':
    'CAN-3253 2026-11-03: needs CANCORE_INTENT_STAND_ENV (full intent stand); no lane passes it and the name lacks the .stand suffix sdk-stand-specs.yml selects',
  'packages/trader/test/quotes.int.test.ts':
    'CAN-3253 2026-11-03: needs FILLER_GATEWAY_URL of a live filler-gateway; no lane provides one (CAN-1876)',
  'packages/trader/test/ticket.int.test.ts':
    'CAN-3253 2026-11-03: needs FILLER_GATEWAY_URL/REDIS_URL/FILLER_ID of a live filler-gateway; no lane provides one (CAN-1876)',
};

export function intSuites(root) {
  return readdirSync(join(root, 'packages'), { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.int.test.ts') && !p.split('/').includes('node_modules'))
    .map((p) => relative(root, join(root, 'packages', p)))
    .sort();
}

const liveWorkflow = (text) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
const canSkip = (source) => /\b(describe|it|test)\.skip\b|\.skipIf\b|\btest\.skip\(/.test(source);

export function unregistered(suites, workflow, read, allowlist) {
  const ci = liveWorkflow(workflow);
  const globRuns = /^\s*-?\s*run:\s*npm run test:int\s*$/m.test(ci);
  return suites.filter((s) => {
    if (ci.includes(s) || s.endsWith('.stand.int.test.ts') || Object.hasOwn(allowlist, s)) return false;
    return !(globRuns && !canSkip(read(s)));
  });
}

test('a skippable suite named nowhere is reported; named, stand-suffixed or always-running ones are not', () => {
  const files = {
    'packages/a/x.int.test.ts': 'const live = env ? describe : describe.skip;',
    'packages/a/named.int.test.ts': 'describe.skip',
    'packages/a/y.stand.int.test.ts': 'describe.skip',
    'packages/a/inproc.int.test.ts': 'describe("real", () => {})',
  };
  const ci = '      - run: npm run test:int\n        npx jest packages/a/named.int.test.ts\n';
  assert.deepEqual(unregistered(Object.keys(files), ci, (s) => files[s], {}), ['packages/a/x.int.test.ts']);
  assert.deepEqual(unregistered(['packages/a/inproc.int.test.ts'], '# npm run test:int\n', (s) => files[s], {}), ['packages/a/inproc.int.test.ts']);
});

test('every *.int.test.ts of this checkout is registered in a lane (CAN-3253)', () => {
  const suites = intSuites(ROOT);
  assert.ok(suites.length > 0, 'no *.int.test.ts found: the check below would be vacuous');
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const gap = unregistered(suites, workflow, (s) => readFileSync(join(ROOT, s), 'utf8'), ALLOWLIST);
  assert.deepEqual(gap, [], `named in no ci.yml step, not *.stand.int.test.ts and able to skip: ${gap.join(', ')} — name it in ci.yml or add it to ALLOWLIST with ticket, reason and date`);
});

test('the allowlist names existing suites only, each with a ticket and a date', () => {
  const suites = new Set(intSuites(ROOT));
  for (const [s, why] of Object.entries(ALLOWLIST)) {
    assert.ok(suites.has(s), `stale ALLOWLIST entry: ${s}`);
    assert.match(why, /\b(CAN|BUG)-\d+\b/);
    assert.match(why, /\b\d{4}-\d{2}-\d{2}\b/);
  }
});
