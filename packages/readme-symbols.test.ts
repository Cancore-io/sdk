import * as fs from 'fs';
import * as path from 'path';

/**
 * Every import line we PUBLISH must name symbols the package actually exports.
 *
 * Documentation rots the way code does not: nothing fails when a rename leaves
 * `import { CancoreProvider }` pointing at a class called something else, and
 * the first person to notice is a stranger integrating against a package that
 * cannot do what its npm page says. This is the cheapest check that catches
 * that, and it is deliberately blunt — it verifies the NAMES exist, not that the
 * surrounding prose is true.
 *
 * Static, not `import()`: the READMEs are read before anything is built, and a
 * doc check that needed `dist/` would only run after the build it is meant to
 * guard.
 */
const ROOT = path.join(__dirname, '..');

const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/**
 * Every package, discovered — never a hand-written list.
 *
 * A list is not a check: it passes for the packages someone remembered to add,
 * and says nothing about the one they did not. This repository already grew from
 * one package to three; the second and third would have been silently
 * undocumented-and-unchecked under a literal.
 */
const PACKAGE_DIRS = fs
  .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'packages', entry.name, 'package.json')))
  .map((entry) => entry.name)
  .sort();

/**
 * module specifier -> the source entry that must export the names.
 *
 * Read off each manifest's `exports`, so a subpath entry (`@cancore/wallet/web`)
 * is covered the day it is added. The map from a published path to a source file
 * is the one tsup applies in reverse: ./dist/web/index.js came from src/web/index.ts.
 */
function entryPoints(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const dir of PACKAGE_DIRS) {
    const manifest = JSON.parse(read(`packages/${dir}/package.json`)) as {
      name: string;
      exports?: Record<string, { import?: string; default?: string } | string>;
    };
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const published = typeof target === 'string' ? target : (target.import ?? target.default);
      if (!published) continue;
      const source = published.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
      entries[specifier] = `packages/${dir}/${source}`;
    }
  }
  return entries;
}

const ENTRIES = entryPoints();

const DOCUMENTS = ['README.md', ...PACKAGE_DIRS.map((dir) => `packages/${dir}/README.md`)];


/** Every name an entry exports, following `export * from './x'` one level down. */
function exportedNames(entryRelative: string): Set<string> {
  const found = new Set<string>();
  const visit = (relative: string) => {
    const source = read(relative);
    for (const [, names] of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const raw of names.split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
        if (name) found.add(name);
      }
    }
    for (const [, name] of source.matchAll(
      /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
    )) {
      found.add(name);
    }
    for (const [, target] of source.matchAll(/export\s+\*\s+from\s+'([^']+)'/g)) {
      visit(path.join(path.dirname(relative), `${target}.ts`));
    }
  };
  visit(entryRelative);
  return found;
}

/** `import { a, b } from 'spec'` occurrences inside fenced code, by specifier. */
function documentedImports(markdown: string): Array<{ spec: string; names: string[] }> {
  const out: Array<{ spec: string; names: string[] }> = [];
  for (const [, names, spec] of markdown.matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
    out.push({
      spec,
      names: names
        .split(',')
        .map((raw) => raw.replace(/^\s*type\s+/, '').trim())
        .filter(Boolean),
    });
  }
  return out;
}

describe('published documentation', () => {
  const exports = Object.fromEntries(
    Object.entries(ENTRIES).map(([spec, file]) => [spec, exportedNames(file)]),
  );

  it.each(DOCUMENTS)('%s imports only symbols the packages export', (document) => {
    const missing: string[] = [];
    for (const { spec, names } of documentedImports(read(document))) {
      const known = exports[spec];
      // An unknown specifier is a documentation bug of its own: it means the
      // README tells people to import from a package that does not exist here.
      expect(known ?? `unknown module ${spec}`).toBeInstanceOf(Set);
      for (const name of names) if (!known.has(name)) missing.push(`${spec}#${name}`);
    }
    expect(missing).toEqual([]);
  });

  it.each(PACKAGE_DIRS)('packages/%s/README.md installs the package it documents', (dir) => {
    // `npm install @cancore/x` installs whatever `latest` is, and the README is
    // what a reader compares it against — so the manifest name and the README's
    // install line must agree, always. A package installed by `npx` says so
    // instead; what is not allowed is a README that names neither.
    const manifest = JSON.parse(read(`packages/${dir}/package.json`)) as { name: string; bin?: unknown };
    const readme = read(`packages/${dir}/README.md`);
    const installs = readme.includes(`npm install ${manifest.name}`);
    const runs = Boolean(manifest.bin) && readme.includes(`npx ${manifest.name}`);
    expect(installs || runs).toBe(true);
  });
});
