import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export const CC_THRESHOLD = 12;
export const LOC_THRESHOLD = 500;
export const LOC_TARGET = 300;
export const DEFAULT_LINE_FLOOR = 90;

export type GateName = 'loc' | 'complexity' | 'any' | 'coverage';
export type Baseline = Readonly<Record<string, number>>;
export type FunctionComplexity = Readonly<{ file: string; name: string; line: number; complexity: number }>;
export type FileCount = Readonly<{ file: string; count: number }>;
export type GrewOffender = Readonly<{ key: string; current: number; allowed: number; detail?: string }>;
export type CoverageMetric = Readonly<{ lines: number; branches: number }>;
export type CoverageSummary = Readonly<{ global: CoverageMetric; files: Readonly<Record<string, CoverageMetric>> }>;
export type CoverageFloors = Readonly<{ global: { readonly lines: number }; files: Baseline }>;
export type CoverageMode = 'node-test' | 'jest-packages';
export type QualityGatesConfig = Readonly<{
  sourceDirs?: readonly string[];
  excludePrefixes?: readonly string[];
  coverageMode?: CoverageMode;
  testGlobs?: string;
}>;
export type FailVerdict = Readonly<{
  kind: 'fail';
  gate: GateName;
  newOffenders: ReadonlyArray<FunctionComplexity | FileCount>;
  grewOffenders: readonly GrewOffender[];
  regressions: readonly GrewOffender[];
  failures: readonly string[];
}>;
export type GateVerdict = { readonly kind: 'pass'; readonly gate: GateName } | FailVerdict;

export function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

const SK = ts.SyntaxKind;
const FLOW_A = [SK.IfStatement, SK.ForStatement, SK.ForInStatement, SK.ForOfStatement, SK.WhileStatement];
const FLOW_B = [SK.DoStatement, SK.SwitchStatement, SK.CatchClause, SK.ConditionalExpression];
const FLOW_KINDS = new Set<ts.SyntaxKind>([...FLOW_A, ...FLOW_B]);
const FN_A = [SK.FunctionDeclaration, SK.MethodDeclaration, SK.ArrowFunction, SK.FunctionExpression];
const FUNCTION_KINDS = new Set<ts.SyntaxKind>([...FN_A, SK.Constructor, SK.GetAccessor, SK.SetAccessor]);
const LOGICAL_OPS = new Set<ts.SyntaxKind>([SK.AmpersandAmpersandToken, SK.BarBarToken, SK.QuestionQuestionToken]);

function functionDisplayName(node: ts.Node, sf: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText(sf);
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isPropertyAssignment(node.parent) && node.parent.name) return node.parent.name.getText(sf);
  return '<anonymous>';
}

function isElseIf(node: ts.Node): boolean {
  return ts.isIfStatement(node) && ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
}

function isLabeledJump(node: ts.Node): boolean {
  return (ts.isBreakStatement(node) || ts.isContinueStatement(node)) && Boolean(node.label);
}

function nodeIncrement(node: ts.Node, depth: number): readonly [number, number] {
  if (isElseIf(node)) return [1, depth];
  if (FLOW_KINDS.has(node.kind)) return [1 + depth, depth + 1];
  if (ts.isBinaryExpression(node) && LOGICAL_OPS.has(node.operatorToken.kind)) {
    const parentOp = ts.isBinaryExpression(node.parent) ? node.parent.operatorToken.kind : undefined;
    return [parentOp === node.operatorToken.kind ? 0 : 1, depth];
  }
  return [isLabeledJump(node) ? 1 : 0, depth];
}

function scoreAstBody(body: ts.Node): number {
  let score = 0;
  const walk = (n: ts.Node, depth: number): void => {
    if (FUNCTION_KINDS.has(n.kind)) return;
    const [inc, nextDepth] = nodeIncrement(n, depth);
    score += inc;
    ts.forEachChild(n, (c) => walk(c, nextDepth));
  };
  if (ts.isBlock(body)) ts.forEachChild(body, (c) => walk(c, 0));
  else walk(body, 0);
  return score;
}

export function analyzeFunctionsInSource(sourceText: string, relFile: string): FunctionComplexity[] {
  const sf = ts.createSourceFile(relFile, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: FunctionComplexity[] = [];
  const visit = (node: ts.Node): void => {
    if (FUNCTION_KINDS.has(node.kind)) {
      const fn = node as ts.FunctionLikeDeclarationBase;
      if (fn.body) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        out.push({ file: relFile, name: functionDisplayName(node, sf), line, complexity: scoreAstBody(fn.body) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function countLinesInContent(sourceText: string): number {
  if (sourceText.length === 0) return 0;
  return (sourceText.endsWith('\n') ? sourceText.slice(0, -1) : sourceText).split('\n').length;
}

export function countAnyInContent(sourceText: string, relFile = 'file.ts'): number {
  const sf = ts.createSourceFile(relFile, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (node.kind === SK.AnyKeyword) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

const EXCLUDED_SUBSTRINGS = ['/test/', '/dist/', '/node_modules/', 'packages/contracts/src/generated/'];
const EXCLUDED_SUFFIXES = ['.d.ts', '.test.ts', '.spec.ts'];

export function isExcludedProdFile(relFile: string, excludePrefixes: readonly string[] = []): boolean {
  const norm = relFile.replace(/\\/g, '/');
  if (!norm.endsWith('.ts') && !norm.endsWith('.tsx')) return true;
  if (excludePrefixes.some((p) => norm.startsWith(p))) return true;
  return EXCLUDED_SUFFIXES.some((s) => norm.endsWith(s)) || EXCLUDED_SUBSTRINGS.some((s) => norm.includes(s));
}

function worstPerFile(units: readonly FunctionComplexity[], threshold: number): Map<string, FunctionComplexity> {
  const maxByFile = new Map<string, FunctionComplexity>();
  for (const u of units) {
    if (u.complexity <= threshold) continue;
    const prev = maxByFile.get(u.file);
    if (!prev || u.complexity > prev.complexity) maxByFile.set(u.file, u);
  }
  return maxByFile;
}

export function evaluateComplexityRatchet(
  units: readonly FunctionComplexity[],
  base: Baseline,
  limit = CC_THRESHOLD,
): GateVerdict {
  const newOffenders: FunctionComplexity[] = [];
  const grewOffenders: GrewOffender[] = [];
  for (const [file, worst] of worstPerFile(units, limit)) {
    const cap = base[file];
    if (cap === undefined) newOffenders.push(worst);
    else if (worst.complexity > cap) {
      grewOffenders.push({ key: file, current: worst.complexity, allowed: cap, detail: `${worst.name}:${worst.line}` });
    }
  }
  if (newOffenders.length === 0 && grewOffenders.length === 0) return { kind: 'pass', gate: 'complexity' };
  const failures = [
    ...newOffenders.map((o) => `NEW ${o.file}:${o.line} ${o.name} (CC=${o.complexity}, limit=${limit})`),
    ...grewOffenders.map((g) => `GREW ${g.key}: ${g.current} > baseline ${g.allowed}`),
  ];
  return { kind: 'fail', gate: 'complexity', newOffenders, grewOffenders, regressions: [], failures };
}

function evaluateCountRatchet(
  gate: 'loc' | 'any',
  files: readonly FileCount[],
  base: Baseline,
  limit: number,
): GateVerdict {
  const newOffenders: FileCount[] = [];
  const grewOffenders: GrewOffender[] = [];
  for (const item of files) {
    if (item.count <= limit) continue;
    const cap = base[item.file];
    if (cap === undefined) newOffenders.push(item);
    else if (item.count > cap) grewOffenders.push({ key: item.file, current: item.count, allowed: cap });
  }
  if (newOffenders.length === 0 && grewOffenders.length === 0) return { kind: 'pass', gate };
  const failures = [
    ...newOffenders.map((o) => `NEW ${o.file} (${o.count} > ${limit})`),
    ...grewOffenders.map((g) => `GREW ${g.key}: ${g.current} > baseline ${g.allowed}`),
  ];
  return { kind: 'fail', gate, newOffenders, grewOffenders, regressions: [], failures };
}

export function evaluateLocRatchet(files: readonly FileCount[], base: Baseline, limit = LOC_THRESHOLD): GateVerdict {
  return evaluateCountRatchet('loc', files, base, limit);
}

export function evaluateAnyRatchet(files: readonly FileCount[], base: Baseline): GateVerdict {
  return evaluateCountRatchet('any', files, base, 0);
}

export function evaluateCoverageRatchet(
  summary: CoverageSummary,
  floors: CoverageFloors,
  defFloor = DEFAULT_LINE_FLOOR,
): GateVerdict {
  const regressions: GrewOffender[] = [];
  if (summary.global.lines < floors.global.lines) {
    regressions.push({ key: 'global.lines', current: summary.global.lines, allowed: floors.global.lines });
  }
  for (const [key, metric] of Object.entries(summary.files)) {
    const allowed = floors.files[key] ?? defFloor;
    if (metric.lines < allowed) regressions.push({ key, current: metric.lines, allowed });
  }
  if (regressions.length === 0) return { kind: 'pass', gate: 'coverage' };
  const failures = regressions.map((r) => `REGRESSED ${r.key}: ${r.current}% < floor ${r.allowed}%`);
  return { kind: 'fail', gate: 'coverage', newOffenders: [], grewOffenders: [], regressions, failures };
}

export function nextComplexityBaseline(
  units: readonly FunctionComplexity[],
  prev: Baseline,
  limit = CC_THRESHOLD,
  boot = false,
): Record<string, number> {
  const maxByFile = worstPerFile(units, limit);
  const next: Record<string, number> = {};
  for (const file of [...maxByFile.keys()].sort()) {
    const prior = prev[file];
    if (prior === undefined && !boot) continue;
    const current = maxByFile.get(file)?.complexity ?? 0;
    next[file] = prior !== undefined ? Math.min(prior, current) : current;
  }
  return next;
}

function nextCountBaseline(
  files: readonly FileCount[],
  prev: Baseline,
  limit: number,
  boot: boolean,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const item of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    if (item.count <= limit) continue;
    const prior = prev[item.file];
    if (prior === undefined && !boot) continue;
    next[item.file] = prior !== undefined ? Math.min(prior, item.count) : item.count;
  }
  return next;
}

export function nextLocBaseline(
  files: readonly FileCount[],
  prev: Baseline,
  limit = LOC_THRESHOLD,
  boot = false,
): Record<string, number> {
  return nextCountBaseline(files, prev, limit, boot);
}

export function nextAnyBaseline(files: readonly FileCount[], prev: Baseline, boot = false): Record<string, number> {
  return nextCountBaseline(files, prev, 0, boot);
}

export function nextCoverageFloors(summary: CoverageSummary, prev: CoverageFloors, boot = false): CoverageFloors {
  const files: Record<string, number> = {};
  for (const [file, metric] of Object.entries(summary.files).sort(([a], [b]) => a.localeCompare(b))) {
    const measured = Math.floor(metric.lines);
    if (measured >= DEFAULT_LINE_FLOOR) continue;
    const prior = prev.files[file];
    if (prior === undefined && !boot) continue;
    files[file] = prior !== undefined ? Math.max(prior, measured) : measured;
  }
  return { global: { lines: Math.max(prev.global.lines, Math.floor(summary.global.lines)) }, files };
}

export function formatVerdictSummary(verdict: GateVerdict): string {
  switch (verdict.kind) {
    case 'pass':
      return `✓ ${verdict.gate} gate passed`;
    case 'fail':
      return `✗ ${verdict.gate} gate failed:\n${verdict.failures.map((f) => `  ${f}`).join('\n')}`;
    default:
      return assertNever(verdict);
  }
}

function parseTableMetricRow(parts: readonly string[]): CoverageMetric | null {
  const lines = Number.parseFloat(parts[1] ?? '');
  if (Number.isNaN(lines)) return null;
  const branches = Number.parseFloat(parts[2] ?? '');
  return { lines, branches: Number.isNaN(branches) ? 100 : branches };
}

function recordNodeRow(
  cell0: string,
  parts: readonly string[],
  stack: string[],
  files: Record<string, CoverageMetric>,
): CoverageMetric | null {
  const indent = cell0.search(/\S|$/);
  const name = parts[0] ?? '';
  if (parts[1] === '' && parts[2] === '') {
    stack.length = indent;
    stack[indent] = name.replace(/\/$/, '');
    return null;
  }
  const metric = parseTableMetricRow(parts);
  if (!metric || name === 'all files') return name === 'all files' ? metric : null;
  if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
    files[[...stack.slice(0, indent), name].join('/')] = metric;
  }
  return null;
}

export function parseNodeCoverageTable(output: string): CoverageSummary | null {
  const files: Record<string, CoverageMetric> = {};
  const stack: string[] = [];
  let globalMetric: CoverageMetric | null = null;
  for (const rawLine of output.split('\n')) {
    if (!rawLine.includes('|')) continue;
    const stripped = rawLine.replace(/^\s*[ℹ#]\s?/, '');
    const parts = stripped.split('|').map((s) => s.trim());
    if (parts.length < 4 || !parts[0] || parts[0] === 'file') continue;
    const g = recordNodeRow(stripped, parts, stack, files);
    if (g) globalMetric = g;
  }
  return globalMetric ? { global: globalMetric, files } : null;
}

type JestStat = { readonly total?: number; readonly covered?: number; readonly pct?: number };
type JestFileEntry = { readonly lines?: JestStat; readonly branches?: JestStat };
type BucketTotals = { readonly lt: number; readonly lc: number; readonly bt: number; readonly bc: number };

function bucketForPath(rel: string): string | undefined {
  const match = rel.match(/^(packages\/[^/]+)\//);
  return match ? match[1] : rel.startsWith('scripts/') ? 'scripts' : undefined;
}

function pctFromAcc(covered: number, total: number): number {
  return total > 0 ? Number(((covered / total) * 100).toFixed(2)) : 100;
}

function addEntryMetrics(prev: BucketTotals | undefined, e: JestFileEntry): BucketTotals {
  const b = prev ?? { lt: 0, lc: 0, bt: 0, bc: 0 };
  return {
    lt: b.lt + (e.lines?.total ?? 0),
    lc: b.lc + (e.lines?.covered ?? 0),
    bt: b.bt + (e.branches?.total ?? 0),
    bc: b.bc + (e.branches?.covered ?? 0),
  };
}

export function parseJestCoverageSummary(
  raw: Readonly<Record<string, JestFileEntry>>,
  rootDir: string,
): CoverageSummary {
  const global = { lines: raw.total?.lines?.pct ?? 0, branches: raw.total?.branches?.pct ?? 0 };
  const totals = new Map<string, BucketTotals>();
  for (const [key, entry] of Object.entries(raw)) {
    const bucket = key === 'total' ? undefined : bucketForPath(relative(rootDir, key).split(sep).join('/'));
    if (bucket) totals.set(bucket, addEntryMetrics(totals.get(bucket), entry));
  }
  const files: Record<string, CoverageMetric> = {};
  for (const [bucket, acc] of totals) {
    files[bucket] = { lines: pctFromAcc(acc.lc, acc.lt), branches: pctFromAcc(acc.bc, acc.bt) };
  }
  return { global, files };
}

function loadConfig(rootDir: string): QualityGatesConfig {
  const cfgPath = join(rootDir, 'scripts', 'quality-gates.config.json');
  return existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as QualityGatesConfig) : {};
}

export function walkProductionFiles(rootDir: string, overrideDirs?: readonly string[]): string[] {
  const cfg = loadConfig(rootDir);
  const dirs = overrideDirs ?? cfg.sourceDirs ?? ['packages', 'src', 'scripts'];
  const excludes = cfg.excludePrefixes ?? [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(rootDir, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') walk(full);
      } else if (!isExcludedProdFile(rel, excludes)) out.push(full);
    }
  };
  for (const d of dirs) walk(join(rootDir, d));
  return out.sort();
}

function loadJson<T>(filePath: string, fallback: T): T {
  return existsSync(filePath) ? (JSON.parse(readFileSync(filePath, 'utf8')) as T) : fallback;
}

function writeJson(filePath: string, data: unknown): number {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return 0;
}

function reportVerdict(verdict: GateVerdict): number {
  const msg = formatVerdictSummary(verdict);
  if (verdict.kind === 'pass') {
    console.log(msg);
    return 0;
  }
  console.error(msg);
  return 1;
}

function collectCoverageSummary(rootDir: string, cfg: QualityGatesConfig): CoverageSummary | null {
  if ((cfg.coverageMode ?? 'jest-packages') === 'node-test') {
    const globs = cfg.testGlobs ?? '"packages/node/test/**/*.test.ts" "scripts/*.test.ts"';
    const cmd = `--test --experimental-test-coverage --test-timeout=60000 ${globs}`;
    const run = spawnSync(`${process.execPath} ${cmd}`, { cwd: rootDir, encoding: 'utf8', shell: true });
    const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    if (run.status !== 0) {
      console.error(out);
      return null;
    }
    return parseNodeCoverageTable(out);
  }
  const summaryPath = join(rootDir, 'coverage', 'coverage-summary.json');
  if (!existsSync(summaryPath)) {
    console.error('Missing coverage/coverage-summary.json; run tests with coverage first');
    return null;
  }
  const raw = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, JestFileEntry>;
  return parseJestCoverageSummary(raw, rootDir);
}

function runCoverageCli(rootDir: string, scriptsDir: string, update: boolean, bootstrap: boolean): number {
  const cfg = loadConfig(rootDir);
  const floorsPath = join(scriptsDir, 'coverage-floors.json');
  const floors = loadJson<CoverageFloors>(floorsPath, { global: { lines: DEFAULT_LINE_FLOOR }, files: {} });
  const summary = collectCoverageSummary(rootDir, cfg);
  if (!summary) return 1;
  if (bootstrap) return writeJson(floorsPath, nextCoverageFloors(summary, floors, true));
  if (update) {
    const next = nextCoverageFloors(summary, floors, false);
    writeJson(floorsPath, next);
    return reportVerdict(evaluateCoverageRatchet(summary, next));
  }
  return reportVerdict(evaluateCoverageRatchet(summary, floors));
}

export function runCli(rootDir: string, argv: readonly string[]): number {
  const gate = argv[0] as GateName | undefined;
  const upd = argv.includes('--update');
  const boot = argv.includes('--bootstrap');
  const dir = join(rootDir, 'scripts');
  if (gate === 'coverage') return runCoverageCli(rootDir, dir, upd, boot);
  const finish = (name: string, next: (b: Baseline) => Baseline, check: (b: Baseline) => GateVerdict): number => {
    const file = join(dir, name);
    const base = loadJson<Record<string, number>>(file, {});
    if (!upd && !boot) return reportVerdict(check(base));
    const updated = next(base);
    writeJson(file, updated);
    return boot ? 0 : reportVerdict(check(updated));
  };
  const files = walkProductionFiles(rootDir).map((f) => ({
    rel: relative(rootDir, f).split(sep).join('/'),
    content: readFileSync(f, 'utf8'),
  }));
  if (gate === 'loc') {
    const items = files.map((f) => ({ file: f.rel, count: countLinesInContent(f.content) }));
    const next = (b: Baseline) => nextLocBaseline(items, b, LOC_THRESHOLD, boot);
    return finish('loc-baseline.json', next, (b) => evaluateLocRatchet(items, b));
  }
  if (gate === 'complexity') {
    const items = files.flatMap((f) => analyzeFunctionsInSource(f.content, f.rel));
    const next = (b: Baseline) => nextComplexityBaseline(items, b, CC_THRESHOLD, boot);
    return finish('cc-baseline.json', next, (b) => evaluateComplexityRatchet(items, b));
  }
  if (gate === 'any') {
    const items = files.map((f) => ({ file: f.rel, count: countAnyInContent(f.content, f.rel) }));
    const next = (b: Baseline) => nextAnyBaseline(items, b, boot);
    return finish('any-baseline.json', next, (b) => evaluateAnyRatchet(items, b));
  }
  console.error('Usage: quality-gates <loc|complexity|any|coverage> [--update|--bootstrap]');
  return 1;
}

if (process.argv[1]?.endsWith('quality-gates.ts')) {
  process.exit(runCli(process.cwd(), process.argv.slice(2)));
}
