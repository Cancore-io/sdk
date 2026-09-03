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

/** module specifier -> the entry file that must export the names */
const ENTRIES: Record<string, string> = {
  '@cancore/dapp-connector': 'packages/dapp-connector/src/index.ts',
};

const DOCUMENTS = ['README.md', 'packages/dapp-connector/README.md'];

const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

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

  it('publishes the version its install line implies', () => {
    // `npm install @cancore/dapp-connector` installs whatever `latest` is, and
    // the README is what a reader compares it against — so the manifest name and
    // the README's install line must agree, always.
    const manifest = JSON.parse(read('packages/dapp-connector/package.json')) as { name: string };
    expect(read('packages/dapp-connector/README.md')).toContain(`npm install ${manifest.name}`);
  });
});
