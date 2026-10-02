import * as fs from 'fs';
import * as path from 'path';

/**
 * `npm run typecheck` names packages one by one: `tsc --build` covers the
 * root config, which excludes every package that has its own tsconfig, and
 * each of those is checked by its own `tsc --noEmit -p`. A package added with
 * a tsconfig but without its line in the script is checked by nobody, and the
 * green run says nothing about it. This holds the script to the directory.
 */
const ROOT = path.join(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const packagesWithTsconfig = fs
  .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'packages', entry.name, 'tsconfig.json')))
  .map((entry) => entry.name)
  .sort();

const script = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts.typecheck ?? '';

describe('root typecheck script', () => {
  test('finds packages to check (not vacuous)', () => {
    expect(packagesWithTsconfig).toContain('trader');
  });

  test.each(packagesWithTsconfig)('checks packages/%s with its own tsconfig', (dir) => {
    expect(script).toContain(`tsc --noEmit -p packages/${dir}/tsconfig.json`);
  });

  test.each(packagesWithTsconfig)('the root config excludes packages/%s, which is checked on its own', (dir) => {
    expect(read('tsconfig.json')).toContain(`"packages/${dir}/**"`);
  });
});
