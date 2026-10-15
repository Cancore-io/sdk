import * as fs from 'fs';
import * as path from 'path';
import { builtinModules } from 'module';
import { parseRequest, RISK_CLASS, METHODS } from './protocol/index';

const SRC = __dirname;
const FORBIDDEN = /keystore|signer|engine|daemon|cli|audit|state|ipc/;

/** Every relative import reachable from a file, transitively. */
function reachable(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = fs.readFileSync(file, 'utf8');
  for (const [, spec] of text.matchAll(/(?:import|export)(?:[^'"]*from)?\s*['"](\.[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), spec!.replace(/\.js$/, ''));
    const next = [`${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')].find((f) => fs.existsSync(f));
    if (next) reachable(next, seen);
  }
  return seen;
}

describe('@cancore/botd/protocol', () => {
  test('source entry imports no key-handling module', () => {
    const files = [...reachable(path.join(SRC, 'protocol/index.ts'))].map((f) => path.relative(SRC, f));
    expect(files.filter((f) => FORBIDDEN.test(f))).toEqual([]);
  });

  const built = path.join(SRC, '..', 'dist', 'protocol', 'index.js');
  (fs.existsSync(built) ? test : test.skip)('built entry imports no key-handling chunk', () => {
    const files = [...reachable(built)].map((f) => fs.readFileSync(f, 'utf8'));
    for (const text of files) expect(text).not.toMatch(/not implemented|createKeystore|createSigner/);
  });

  test('every method has a risk class', () => {
    expect(Object.keys(RISK_CLASS).sort()).toEqual([...METHODS].sort());
  });

  test('parseRequest validates envelope, method and params', () => {
    expect(parseRequest({ jsonrpc: '2.0', id: 1, method: 'status' })).toMatchObject({ ok: true });
    expect(parseRequest({ jsonrpc: '2.0', id: 1, method: 'transfer' })).toMatchObject({ ok: false, error: { code: -32601 } });
    expect(parseRequest({ jsonrpc: '2.0', id: 1, method: 'order.take', params: { orderId: 'x', amount: '-1' } })).toMatchObject({
      ok: false,
      error: { code: -32602 },
    });
  });
});

describe('@cancore/botd/ipc/client', () => {
  test('source entry reaches only the protocol', () => {
    const files = [...reachable(path.join(SRC, 'ipc/client.ts'))].map((f) => path.relative(SRC, f)).sort();
    expect(files).toEqual(['ipc/client.ts', 'protocol/index.ts']);
  });

  const built = path.join(SRC, '..', 'dist', 'ipc', 'client.js');
  (fs.existsSync(built) ? test : test.skip)('built entry imports only node built-ins and zod', () => {
    const files = [...reachable(built)].map((f) => fs.readFileSync(f, 'utf8'));
    for (const text of files) {
      expect(text).not.toMatch(/not implemented|createKeystore|createSigner/);
      for (const [, spec] of text.matchAll(/(?:import|export)[^'"]*from\s+['"]([^.'"][^'"]*)['"]/g)) {
        expect(builtinModules.includes(spec!.replace(/^node:/, '')) || spec === 'zod' ? spec : `forbidden: ${spec}`).toBe(spec);
      }
    }
  });
});
