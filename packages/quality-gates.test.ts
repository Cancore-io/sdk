import * as fs from 'fs';
import * as path from 'path';
import {
  CC_THRESHOLD,
  DEFAULT_LINE_FLOOR,
  LOC_THRESHOLD,
  analyzeFunctionsInSource,
  assertNever,
  countAnyInContent,
  countLinesInContent,
  evaluateAnyRatchet,
  evaluateComplexityRatchet,
  evaluateCoverageRatchet,
  evaluateLocRatchet,
  formatVerdictSummary,
   isExcludedProdFile,
  nextAnyBaseline,
  nextComplexityBaseline,
  nextCoverageFloors,
  nextLocBaseline,
  parseJestCoverageSummary,
  parseNodeCoverageTable,
  runCli,
  walkProductionFiles,
  type GateVerdict,
} from '../scripts/quality-gates';

const ROOT = path.join(__dirname, '..');

describe('CAN-2934 quality gates (@happy, @negative, @edge)', () => {
  test('@happy: CONTRIBUTING.md, README.md, and PR template document all English quality gates and checkboxes', () => {
    expect(CC_THRESHOLD).toBe(12);
    expect(LOC_THRESHOLD).toBe(500);
    expect(DEFAULT_LINE_FLOOR).toBe(90);

    const contributingPath = path.join(ROOT, 'CONTRIBUTING.md');
    const readmePath = path.join(ROOT, 'README.md');
    const prTemplatePath = path.join(ROOT, '.github', 'pull_request_template.md');

    expect(fs.existsSync(contributingPath)).toBe(true);
    expect(fs.existsSync(prTemplatePath)).toBe(true);

    const contributing = fs.readFileSync(contributingPath, 'utf8');
    const readme = fs.readFileSync(readmePath, 'utf8');
    const prTemplate = fs.readFileSync(prTemplatePath, 'utf8');

    expect(readme).toMatch(/CONTRIBUTING\.md/);
    expect(contributing).toMatch(/CAN-2777/);
    expect(contributing).toMatch(/90%/);
    expect(contributing).toMatch(/Mutation Testing \(Local & Nx Blast-Radius Gate\)/);
    expect(contributing).toMatch(/blast-radius|nx affected/i);
    expect(contributing).toMatch(/500/);
    expect(contributing).toMatch(/300/);
    expect(contributing).toMatch(/12/);
    expect(contributing).toMatch(/assertNever/);

    const requiredCheckboxes = [
      '- [ ] Comments: why-only in English (CAN-2777)',
      '- [ ] Unit tests & coverage (local-only — running unit tests in CI is prohibited during the current phase): ≥ 90% line coverage',
      '- [ ] Local + nx/blast-radius mutation testing:',
      '- [ ] File size (LOC): target < 300 LOC, hard cap ≤ 500 LOC',
      '- [ ] Cognitive complexity: CC ≤ 12 per function',
      '- [ ] Type safety (no any): 0 new explicit any',
      '- [ ] Algebraic Data Types (ADT): fixed variant sets modeled as discriminated unions with exhaustive default: return assertNever(x)',
      '- [ ] Local stand verification:',
      '- [ ] Allure & Docs-as-Code RTM traceability:',
    ];
    for (const box of requiredCheckboxes) {
      expect(contributing).toContain(box);
      expect(prTemplate).toContain(box);
    }

    const ciYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(/^\s*-\s*run:\s*npm test\b/m.test(ciYml)).toBe(false);
    expect(/^\s*-\s*run:\s*npm run coverage:check\b/m.test(ciYml)).toBe(false);
    expect(ciYml).toMatch(/sha256sum -c/);
  });

  test('@happy: clean module with CC <= 12, LOC <= 500, 0 any, coverage >= 90%, and exhaustive ADT passes all gates', () => {
    const cleanSource = [
      "export type OrderState = { readonly status: 'open'; readonly id: string } | { readonly status: 'cancelled'; readonly reason: string };",
      'export function formatOrderState(state: OrderState): string {',
      '  switch (state.status) {',
      "    case 'open':",
      '      return state.id;',
      "    case 'cancelled':",
      '      return state.reason;',
      '    default:',
      '      return assertNever(state);',
      '  }',
      '}',
    ].join('\n');

    const fns = analyzeFunctionsInSource(cleanSource, 'packages/client/src/clean.ts');
    expect(fns).toHaveLength(1);
    expect(fns[0]?.complexity).toBe(1);
    expect(countAnyInContent(cleanSource, 'packages/client/src/clean.ts')).toBe(0);
    expect(countLinesInContent(cleanSource)).toBe(11);

    expect(evaluateComplexityRatchet(fns, {}).kind).toBe('pass');
    expect(evaluateLocRatchet([{ file: 'packages/client/src/clean.ts', count: 11 }], {}).kind).toBe('pass');
    expect(evaluateAnyRatchet([{ file: 'packages/client/src/clean.ts', count: 0 }], {}).kind).toBe('pass');
    expect(
      evaluateCoverageRatchet(
        { global: { lines: 94.2, branches: 80 }, files: { 'packages/client': { lines: 98.1, branches: 87 } } },
        { global: { lines: 90 }, files: { 'packages/client': 90 } },
      ).kind,
    ).toBe('pass');
  });

  test('@negative: rejects CC = 13 (limit 12), LOC = 501 (limit 500), explicit any forms, coverage < 90%, and unhandled ADT variant', () => {
    const branches = Array.from({ length: 13 }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n');
    const complexSource = `export function overLimit(x: number): number {\n${branches}\n  return -1;\n}\n`;
    const units = analyzeFunctionsInSource(complexSource, 'packages/trader/src/over.ts');
    expect(units[0]?.complexity).toBe(13);

    const ccVerdict = evaluateComplexityRatchet(units, {});
    expect(ccVerdict.kind).toBe('fail');
    if (ccVerdict.kind === 'fail') {
      expect(ccVerdict.newOffenders).toHaveLength(1);
    }
    expect(formatVerdictSummary(ccVerdict)).toMatch(/packages\/trader\/src\/over\.ts/);

    const locVerdict = evaluateLocRatchet([{ file: 'packages/trader/src/god.ts', count: 501 }], {});
    expect(locVerdict.kind).toBe('fail');

    const anySource = [
      '// comment with any and string "as any"',
      'export function leaky(a: any, b: Record<string, any>, c: any[]): Promise<any> {',
      '  return Promise.resolve((a as any) ?? b ?? c);',
      '}',
    ].join('\n');
    const anyCount = countAnyInContent(anySource, 'packages/bot-mcp/src/leaky.ts');
    expect(anyCount).toBe(5);
    expect(evaluateAnyRatchet([{ file: 'packages/bot-mcp/src/leaky.ts', count: anyCount }], {}).kind).toBe('fail');

    const covVerdict = evaluateCoverageRatchet(
      { global: { lines: 94, branches: 80 }, files: { 'packages/new-pkg': { lines: 89.4, branches: 80 } } },
      { global: { lines: 90 }, files: {} },
    );
    expect(covVerdict.kind).toBe('fail');
    expect(() => assertNever('unhandled' as never)).toThrow(/unreachable/);

    const fUnits = analyzeFunctionsInSource(
      'export const f = (x: number) => x === 0 ? 0 : x === 1 ? 1 : x === 2 ? 2 : x === 3 ? 3 : x === 4 ? 4 : 5;',
      'packages/trader/src/f.ts',
    );
    const gUnits = analyzeFunctionsInSource(
      'export const g = (x: number) => { return x === 0 ? 0 : x === 1 ? 1 : x === 2 ? 2 : x === 3 ? 3 : x === 4 ? 4 : 5; };',
      'packages/trader/src/g.ts',
    );
    expect(fUnits[0]?.name).toBe('f');
    expect(fUnits[0]?.complexity).toBe(15);
    expect(gUnits[0]?.name).toBe('g');
    expect(gUnits[0]?.complexity).toBe(15);
    const ternaryVerdict = evaluateComplexityRatchet([...fUnits, ...gUnits], {});
    expect(ternaryVerdict.kind).toBe('fail');
    if (ternaryVerdict.kind === 'fail' && ternaryVerdict.gate === 'complexity') {
      expect(ternaryVerdict.newOffenders).toHaveLength(2);
    }
  });

  test('@edge: baseline ratchet permits untouched legacy ceilings, blocks +1 growth with GREW, excludes generated files, and --update only tightens', () => {
    expect(isExcludedProdFile('packages/contracts/src/generated/types.ts')).toBe(true);
    expect(isExcludedProdFile('packages/client/spec/openapi.json')).toBe(true);
    expect(isExcludedProdFile('packages/client/src/swap.test.ts')).toBe(true);
    expect(isExcludedProdFile('packages/client/src/swap.ts')).toBe(false);

    const legacy = { file: 'packages/botd/src/daemon.ts', name: 'execute', line: 339, complexity: 75 };
    expect(evaluateComplexityRatchet([legacy], { 'packages/botd/src/daemon.ts': 75 }).kind).toBe('pass');

    const grown = evaluateComplexityRatchet([{ ...legacy, complexity: 76 }], { 'packages/botd/src/daemon.ts': 75 });
    expect(grown.kind).toBe('fail');
    expect(formatVerdictSummary(grown)).toMatch(/GREW/);

    expect(
      nextComplexityBaseline(
        [
          { ...legacy, complexity: 50 },
          { file: 'packages/client/src/auth.ts', name: 'login', line: 10, complexity: 12 },
        ],
        { 'packages/botd/src/daemon.ts': 75, 'packages/client/src/auth.ts': 13 },
      ),
    ).toEqual({ 'packages/botd/src/daemon.ts': 50 });

    expect(
      nextLocBaseline(
        [
          { file: 'packages/client/src/selfcustody.ts', count: 1400 },
          { file: 'packages/trader/src/filler/tickets/desk.ts', count: 500 },
        ],
        { 'packages/client/src/selfcustody.ts': 1685, 'packages/trader/src/filler/tickets/desk.ts': 530 },
      ),
    ).toEqual({ 'packages/client/src/selfcustody.ts': 1400 });

    expect(
      nextAnyBaseline(
        [{ file: 'packages/bot-mcp/src/server.ts', count: 2 }],
        { 'packages/bot-mcp/src/server.ts': 4 },
      ),
    ).toEqual({ 'packages/bot-mcp/src/server.ts': 2 });

    const nextFloors = nextCoverageFloors(
      {
        global: { lines: 94.2, branches: 80 },
        files: {
          'packages/bot-mcp': { lines: 83.4, branches: 85 },
          'packages/client': { lines: 98.1, branches: 87 },
        },
      },
      {
        global: { lines: 90 },
        files: {
          'packages/bot-mcp': 79,
          'packages/client': 95,
        },
      },
    );
    expect(nextFloors.global.lines).toBe(94);
    expect(nextFloors.files['packages/bot-mcp']).toBe(83);
    expect(nextFloors.files['packages/client']).toBe(98);

    const f4Prev = { global: { lines: 93 }, files: { 'packages/client': 98 } };
    const f4Summary = {
      global: { lines: 94, branches: 85 },
      files: { 'packages/client': { lines: 97, branches: 85 } },
    };
    const f4Next = nextCoverageFloors(f4Summary, f4Prev, false);
    expect(f4Next.files['packages/client']).toBe(98);
    const f4Verdict = evaluateCoverageRatchet(f4Summary, f4Next);
    expect(f4Verdict.kind).toBe('fail');
    expect(formatVerdictSummary(f4Verdict)).toMatch(/REGRESSED packages\/client: 97% < floor 98%/);

    expect(
      nextComplexityBaseline([{ file: 'packages/client/src/new-offender.ts', name: 'bad', line: 1, complexity: 15 }], {}),
    ).toEqual({});
    expect(nextLocBaseline([{ file: 'packages/client/src/new-offender.ts', count: 505 }], {})).toEqual({});
    expect(nextAnyBaseline([{ file: 'packages/client/src/new-offender.ts', count: 2 }], {})).toEqual({});

    const checkVerdict = (v: GateVerdict): string => {
      switch (v.kind) {
        case 'pass':
          return v.gate;
        case 'fail':
          return v.gate;
        default:
          return assertNever(v);
      }
    };
    expect(checkVerdict({ kind: 'pass', gate: 'complexity' })).toBe('complexity');

    const prodFiles = walkProductionFiles(ROOT);
    expect(prodFiles.some((f) => f.endsWith('scripts/quality-gates.ts'))).toBe(true);
    expect(prodFiles.some((f) => f.includes('/src/generated/'))).toBe(false);

    const parsedCov = parseJestCoverageSummary(
      {
        total: { lines: { pct: 95.1 }, branches: { pct: 88.2 } },
        [path.join(ROOT, 'packages/client/src/swap.ts')]: {
          lines: { total: 100, covered: 96 },
          branches: { total: 20, covered: 18 },
        },
        [path.join(ROOT, 'scripts/quality-gates.ts')]: {
          lines: { total: 50, covered: 48 },
          branches: { total: 10, covered: 9 },
        },
      },
      ROOT,
    );
    expect(parsedCov.global.lines).toBe(95.1);
    expect(parsedCov.files['packages/client']?.lines).toBe(96);
    expect(parsedCov.files['scripts']?.lines).toBe(96);

    const nodeTable = [
      'ℹ start of coverage report',
      'ℹ file | line % | branch % | funcs % | uncovered lines',
      'ℹ src | | | |',
      'ℹ  api.ts | 99.32 | 72.09 | 90.91 | 112',
      'ℹ  watch.ts | 69.30 | 80.00 | 57.14 | 43-44',
      'ℹ all files | 86.65 | 88.63 | 89.11 |',
      'ℹ end of coverage report',
    ].join('\n');
    const parsedNode = parseNodeCoverageTable(nodeTable);
    expect(parsedNode?.global.lines).toBe(86.65);
    expect(parsedNode?.files['src/api.ts']?.lines).toBe(99.32);

    const parsedNodeWithUnloaded = parseNodeCoverageTable(nodeTable, [
      { file: 'src/api.ts', count: 10 },
      { file: 'src/watch.ts', count: 10 },
      { file: 'src/unloaded-new.ts', count: 10 },
    ]);
    expect(parsedNodeWithUnloaded?.files['src/unloaded-new.ts']).toEqual({ lines: 0, branches: 0 });
    expect((parsedNodeWithUnloaded?.global.lines ?? 100) < (parsedNode?.global.lines ?? 0)).toBe(true);
    const f3Verdict = evaluateCoverageRatchet(parsedNodeWithUnloaded!, {
      global: { lines: 50 },
      files: { 'src/watch.ts': 65 },
    });
    expect(f3Verdict.kind).toBe('fail');
    expect(formatVerdictSummary(f3Verdict)).toMatch(/REGRESSED src\/unloaded-new\.ts: 0% < floor 90%/);

    const f5Table = [
      'ℹ start of coverage report',
      'ℹ file | line % | branch % | funcs % | uncovered lines',
      'ℹ src | | | |',
      ...Array.from({ length: 9 }, (_, i) => `ℹ  m${i + 1}.ts | 100.00 | 100.00 | 100.00 |`),
      'ℹ all files | 100.00 | 100.00 | 100.00 |',
      'ℹ end of coverage report',
    ].join('\n');
    const f5Parsed = parseNodeCoverageTable(f5Table, [
      ...Array.from({ length: 9 }, (_, i) => ({ file: `src/m${i + 1}.ts`, count: 1 })),
      { file: 'src/unloaded-400.ts', count: 400 },
    ]);
    expect(f5Parsed?.global.lines).toBe(2.2);
    const f5Verdict = evaluateCoverageRatchet(f5Parsed!, {
      global: { lines: 78 },
      files: { 'src/unloaded-400.ts': 0 },
    });
    expect(f5Verdict.kind).toBe('fail');
    expect(formatVerdictSummary(f5Verdict)).toMatch(/REGRESSED global\.lines: 2\.2% < floor 78%/);

    expect(runCli(ROOT, ['loc'])).toBe(0);
    expect(runCli(ROOT, ['complexity'])).toBe(0);
    expect(runCli(ROOT, ['any'])).toBe(0);
    expect(runCli(ROOT, ['unknown'])).toBe(1);

    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'sdk-qg-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'scripts', 'quality-gates.config.json'),
        JSON.stringify({
          scanRoots: ['packages'],
          excludeSubstrings: ['/src/generated/', '.test.ts'],
          coverageMode: 'jest-packages',
        }),
      );
      fs.mkdirSync(path.join(tmpDir, 'packages', 'demo', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'packages', 'demo', 'src', 'index.ts'), 'export const x = (n: number): number => n + 1;\n');
      expect(runCli(tmpDir, ['coverage'])).toBe(1);
      fs.mkdirSync(path.join(tmpDir, 'coverage'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'coverage', 'coverage-summary.json'),
        JSON.stringify({
          total: { lines: { pct: 95 }, branches: { pct: 95 } },
          [path.join(tmpDir, 'packages/demo/src/index.ts')]: {
            lines: { total: 10, covered: 10 },
            branches: { total: 2, covered: 2 },
          },
        }),
      );
      expect(runCli(tmpDir, ['loc', '--update'])).toBe(0);
      expect(runCli(tmpDir, ['complexity', '--update'])).toBe(0);
      expect(runCli(tmpDir, ['any', '--update'])).toBe(0);
      expect(runCli(tmpDir, ['coverage', '--update'])).toBe(0);
      expect(runCli(tmpDir, ['coverage'])).toBe(0);

      fs.writeFileSync(
        path.join(tmpDir, 'scripts', 'coverage-floors.json'),
        JSON.stringify({ global: { lines: 93 }, files: { 'packages/demo': 98 } }, null, 2) + '\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'coverage', 'coverage-summary.json'),
        JSON.stringify({
          total: { lines: { pct: 94 }, branches: { pct: 90 } },
          [path.join(tmpDir, 'packages/demo/src/index.ts')]: {
            lines: { total: 100, covered: 97 },
            branches: { total: 10, covered: 9 },
          },
        }),
      );
      expect(runCli(tmpDir, ['coverage', '--update'])).toBe(1);
      expect(
        JSON.parse(fs.readFileSync(path.join(tmpDir, 'scripts', 'coverage-floors.json'), 'utf8')).files[
          'packages/demo'
        ],
      ).toBe(98);
      expect(runCli(tmpDir, ['coverage'])).toBe(1);

      fs.writeFileSync(path.join(tmpDir, 'packages', 'demo', 'src', 'offender.ts'), 'export const bad: any = 1;\n');
      expect(runCli(tmpDir, ['any', '--update'])).toBe(1);
      expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'scripts', 'any-baseline.json'), 'utf8'))).toEqual({});
      expect(runCli(tmpDir, ['any'])).toBe(1);
      fs.rmSync(path.join(tmpDir, 'packages', 'demo', 'src', 'offender.ts'));

      fs.writeFileSync(
        path.join(tmpDir, 'scripts', 'loc-baseline.json'),
        JSON.stringify({ 'packages/demo/src/healed.ts': 520 }) + '\n',
      );
      fs.writeFileSync(path.join(tmpDir, 'packages', 'demo', 'src', 'healed.ts'), 'export const ok = 1;\n');
      expect(runCli(tmpDir, ['loc', '--update'])).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'scripts', 'loc-baseline.json'), 'utf8'))).toEqual({});
      const lines501 = Array.from({ length: 501 }, (_, i) => `export const v${i} = ${i};`).join('\n');
      fs.writeFileSync(path.join(tmpDir, 'packages', 'demo', 'src', 'healed.ts'), lines501);
      expect(runCli(tmpDir, ['loc', '--update'])).toBe(1);
      expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'scripts', 'loc-baseline.json'), 'utf8'))).toEqual({});
      expect(runCli(tmpDir, ['loc'])).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
