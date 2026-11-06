/** Lets a bare `node` child load workspace TypeScript sources the way jest's moduleNameMapper does (CAN-3344). */
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from '@swc/core';

const packagesDir = fileURLToPath(new URL('.', import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    const workspace = /^@cancore\/([^/]+)(?:\/(.+))?$/.exec(specifier);
    if (workspace) {
      const base = `${packagesDir}${workspace[1]}/src/${workspace[2] ?? 'index'}`;
      const file = [`${base}.ts`, `${base}/index.ts`].find((candidate) => existsSync(candidate));
      if (file) return nextResolve(pathToFileURL(file).href, context);
    }
    if (/^\.\.?\//.test(specifier) && context.parentURL?.endsWith('.ts')) {
      for (const suffix of ['', '.ts', '/index.ts']) {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (candidate.pathname.endsWith('.ts') && existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = transformSync(source, { filename: fileURLToPath(url), jsc: { parser: { syntax: 'typescript' }, target: 'es2022', experimental: { keepImportAttributes: true } }, module: { type: 'es6' } });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
