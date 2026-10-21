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
      '- [ ] Unit test coverage: ≥ 90% line coverage',
      '- [ ] Local + nx/blast-radius mutation testing:',
      '- [ ] File size (LOC): target < 300 LOC, hard cap ≤ 500 LOC',
      '- [ ] Cognitive complexity: CC ≤ 12 per function',
      '- [ ] Type safety (no any): 0 new explicit any',
      '- [ ] Algebraic Data Types (ADT): fixed variant sets modeled as discriminated unions with exhaustive default: return assertNever(x)',
      '- [ ] Local stand verification:',
      '- [ ] RTM & Qase:',
    ];
    for (const box of requiredCheckboxes) {
      expect(contributing).toContain(box);
      expect(prTemplate).toContain(box);
    }
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
        { global: { lines: 94.2, branches: 80 }, packages: { 'packages/client': { lines: 98.1, branches: 87 } } },
        { global: { lines: 90 }, packages: { 'packages/client': { lines: 90 } } },
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
    if (ccVerdict.kind === 'fail' && ccVerdict.gate === 'complexity') {
      expect(ccVerdict.newOffenders[0]?.complexity).toBe(13);
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
      { global: { lines: 94, branches: 80 }, packages: { 'packages/new-pkg': { lines: 89.4, branches: 80 } } },
      { global: { lines: 90 }, packages: {} },
    );
    expect(covVerdict.kind).toBe('fail');
    expect(() => assertNever('unhandled' as never)).toThrow(/unreachable/);
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
        packages: {
          'packages/bot-mcp': { lines: 83.4, branches: 85 },
          'packages/client': { lines: 98.1, branches: 87 },
        },
      },
      {
        global: { lines: 90 },
        packages: {
          'packages/bot-mcp': { lines: 79 },
          'packages/client': { lines: 95 },
        },
      },
    );
    expect(nextFloors.global.lines).toBe(94);
    expect(nextFloors.packages['packages/bot-mcp']?.lines).toBe(83);
    expect(nextFloors.packages['packages/client']?.lines).toBe(98);

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
    expect(parsedCov.packages['packages/client']?.lines).toBe(96);
    expect(parsedCov.packages['scripts']?.lines).toBe(96);
    expect(runCli(ROOT, ['loc'])).toBe(0);
    expect(runCli(ROOT, ['complexity'])).toBe(0);
    expect(runCli(ROOT, ['any'])).toBe(0);
    expect(runCli(ROOT, ['unknown'])).toBe(1);

    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'sdk-qg-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
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
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
