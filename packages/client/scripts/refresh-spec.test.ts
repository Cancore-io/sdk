import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs a copy of refresh-spec.mjs on `doc`; the script writes ../spec and ../src next to itself, so the repo is untouched. */
function refresh(doc: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'refresh-spec-'));
  for (const dir of ['scripts', 'spec', 'src']) mkdirSync(join(root, dir));
  copyFileSync(join(__dirname, 'refresh-spec.mjs'), join(root, 'scripts', 'refresh-spec.mjs'));
  writeFileSync(join(root, 'doc.json'), JSON.stringify(doc));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'refresh-spec.mjs'), join(root, 'doc.json')], { encoding: 'utf8' });
  const codesFile = join(root, 'src', 'sdk-error-codes.ts');
  return { status: run.status, stderr: run.stderr, specWritten: existsSync(join(root, 'spec', 'openapi.json')), codes: existsSync(codesFile) ? readFileSync(codesFile, 'utf8') : undefined };
}

const docWith = (codes: unknown[]) => ({ openapi: '3.0.0', paths: { '/x': {} }, components: { schemas: { SdkErrorCode: { type: 'string', enum: codes } } } });

describe('refresh-spec.mjs (BUG-1619)', () => {
  test('an enum value that is not an UPPER_SNAKE code name fails the refresh before anything is written', () => {
    const injected = "X', ...(() => { process.exit(42); })(), '";
    const run = refresh(docWith(['NOT_ELIGIBLE', injected]));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/SdkErrorCode/);
    expect(run.specWritten).toBe(false);
    expect(run.codes).toBeUndefined();
  });

  test.each(['lower_case', 'xLEADING_LOWER', 'WITH SPACE', '1LEADING_DIGIT', 'QUOTE\'', ''])('%j is refused', (code) => {
    expect(refresh(docWith(['NOT_ELIGIBLE', code])).status).not.toBe(0);
  });

  test('UPPER_SNAKE codes are written in spec order', () => {
    const run = refresh(docWith(['NOT_ELIGIBLE', 'RATE_LIMITED_2']));
    expect(run.status).toBe(0);
    expect(run.codes).toContain("  'NOT_ELIGIBLE',\n  'RATE_LIMITED_2',\n] as const;");
  });
});
