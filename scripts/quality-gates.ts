import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export const CC_THRESHOLD = 12;
export const LOC_THRESHOLD = 500;
export const LOC_TARGET = 300;
export const DEFAULT_LINE_FLOOR = 90;

export type GateName = 'loc' | 'complexity' | 'any' | 'coverage';

export interface FunctionComplexity {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly complexity: number;
}

export interface FileCount {
  readonly file: string;
  readonly count: number;
}

export interface GrewOffender {
  readonly key: string;
  readonly current: number;
  readonly allowed: number;
  readonly detail?: string;
}

export interface CoverageMetric {
  readonly lines: number;
  readonly branches: number;
}

export interface CoverageSummary {
  readonly global: CoverageMetric;
  readonly packages: Readonly<Record<string, CoverageMetric>>;
}

export interface CoverageFloorMetric {
  readonly lines: number;
  readonly branches?: number;
}

export interface CoverageFloors {
  readonly global: CoverageFloorMetric;
  readonly packages: Readonly<Record<string, CoverageFloorMetric>>;
}

export type GateVerdict =
  | { readonly kind: 'pass'; readonly gate: GateName }
  | {
      readonly kind: 'fail';
      readonly gate: 'complexity';
      readonly newOffenders: readonly FunctionComplexity[];
      readonly grewOffenders: readonly GrewOffender[];
    }
  | {
      readonly kind: 'fail';
      readonly gate: 'loc' | 'any';
      readonly newOffenders: readonly FileCount[];
      readonly grewOffenders: readonly GrewOffender[];
    }
  | {
      readonly kind: 'fail';
      readonly gate: 'coverage';
      readonly regressions: readonly GrewOffender[];
    };

export function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

const FLOW_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

const FUNCTION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function functionDisplayName(node: ts.Node, sf: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText(sf);
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  if (ts.isPropertyAssignment(node.parent) && node.parent.name) {
    return node.parent.name.getText(sf);
  }
  return '<anonymous>';
}

function isElseIf(node: ts.Node): boolean {
  return ts.isIfStatement(node) && ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
}

function isLogicalOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.AmpersandAmpersandToken ||
    op === ts.SyntaxKind.BarBarToken ||
    op === ts.SyntaxKind.QuestionQuestionToken
  );
}

function nodeIncrement(node: ts.Node, depth: number): readonly [number, number] {
  if (isElseIf(node)) return [1, depth];
  if (FLOW_KINDS.has(node.kind)) return [1 + depth, depth + 1];
  if (ts.isBinaryExpression(node) && isLogicalOperator(node.operatorToken.kind)) {
    const parentOp = ts.isBinaryExpression(node.parent) ? node.parent.operatorToken.kind : undefined;
    return [parentOp === node.operatorToken.kind ? 0 : 1, depth];
  }
  return [0, depth];
}

function scoreAstBody(body: ts.Node): number {
  let score = 0;
  const walk = (n: ts.Node, depth: number): void => {
    if (FUNCTION_KINDS.has(n.kind)) return;
    const [inc, nextDepth] = nodeIncrement(n, depth);
    score += inc;
    ts.forEachChild(n, (c) => walk(c, nextDepth));
  };
  ts.forEachChild(body, (c) => walk(c, 0));
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
  const normalized = sourceText.endsWith('\n') ? sourceText.slice(0, -1) : sourceText;
  return normalized.split('\n').length;
}

export function countAnyInContent(sourceText: string, relFile: string): number {
  const sf = ts.createSourceFile(relFile, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

export function isExcludedProdFile(relFile: string): boolean {
  const normalized = relFile.replace(/\\/g, '/');
  if (!normalized.endsWith('.ts') && !normalized.endsWith('.tsx')) return true;
  return (
    normalized.endsWith('.d.ts') ||
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.spec.ts') ||
    normalized.startsWith('packages/contracts/src/generated/') ||
    normalized.includes('/test/') ||
    normalized.includes('/dist/') ||
    normalized.includes('/node_modules/')
  );
}

export function evaluateComplexityRatchet(
  units: readonly FunctionComplexity[],
  baseline: Readonly<Record<string, number>>,
  threshold: number = CC_THRESHOLD,
): GateVerdict {
  const over = units.filter((u) => u.complexity > threshold);
  const maxByFile = new Map<string, FunctionComplexity>();
  for (const u of over) {
    const prev = maxByFile.get(u.file);
    if (!prev || u.complexity > prev.complexity) maxByFile.set(u.file, u);
  }
  const newOffenders: FunctionComplexity[] = [];
  const grewOffenders: GrewOffender[] = [];
  for (const [file, worst] of maxByFile) {
    const cap = baseline[file];
    if (cap === undefined) newOffenders.push(worst);
    else if (worst.complexity > cap) {
      grewOffenders.push({ key: file, current: worst.complexity, allowed: cap, detail: `${worst.name}:${worst.line}` });
    }
  }
  if (newOffenders.length === 0 && grewOffenders.length === 0) return { kind: 'pass', gate: 'complexity' };
  return { kind: 'fail', gate: 'complexity', newOffenders, grewOffenders };
}

function evaluateCountRatchet(
  gate: 'loc' | 'any',
  files: readonly FileCount[],
  baseline: Readonly<Record<string, number>>,
  threshold: number,
): GateVerdict {
  const newOffenders: FileCount[] = [];
  const grewOffenders: GrewOffender[] = [];
  for (const item of files) {
    if (item.count <= threshold) continue;
    const cap = baseline[item.file];
    if (cap === undefined) newOffenders.push(item);
    else if (item.count > cap) grewOffenders.push({ key: item.file, current: item.count, allowed: cap });
  }
  if (newOffenders.length === 0 && grewOffenders.length === 0) return { kind: 'pass', gate };
  return { kind: 'fail', gate, newOffenders, grewOffenders };
}

export function evaluateLocRatchet(
  files: readonly FileCount[],
  baseline: Readonly<Record<string, number>>,
  threshold: number = LOC_THRESHOLD,
): GateVerdict {
  return evaluateCountRatchet('loc', files, baseline, threshold);
}

export function evaluateAnyRatchet(
  files: readonly FileCount[],
  baseline: Readonly<Record<string, number>>,
): GateVerdict {
  return evaluateCountRatchet('any', files, baseline, 0);
}

export function evaluateCoverageRatchet(
  summary: CoverageSummary,
  floors: CoverageFloors,
  defaultLineFloor: number = DEFAULT_LINE_FLOOR,
): GateVerdict {
  const regressions: GrewOffender[] = [];
  if (summary.global.lines < floors.global.lines) {
    regressions.push({ key: 'global.lines', current: summary.global.lines, allowed: floors.global.lines });
  }
  for (const [pkg, metric] of Object.entries(summary.packages)) {
    const allowed = floors.packages[pkg]?.lines ?? defaultLineFloor;
    if (metric.lines < allowed) {
      regressions.push({ key: `${pkg}.lines`, current: metric.lines, allowed });
    }
  }
  if (regressions.length === 0) return { kind: 'pass', gate: 'coverage' };
  return { kind: 'fail', gate: 'coverage', regressions };
}

export function nextComplexityBaseline(
  units: readonly FunctionComplexity[],
  prev: Readonly<Record<string, number>>,
  threshold: number = CC_THRESHOLD,
): Record<string, number> {
  const maxByFile = new Map<string, number>();
  for (const u of units) {
    if (u.complexity > threshold) {
      maxByFile.set(u.file, Math.max(maxByFile.get(u.file) ?? 0, u.complexity));
    }
  }
  const next: Record<string, number> = {};
  for (const file of [...maxByFile.keys()].sort()) {
    const current = maxByFile.get(file)!;
    const prior = prev[file];
    next[file] = prior !== undefined ? Math.min(prior, current) : current;
  }
  return next;
}

function nextCountBaseline(
  files: readonly FileCount[],
  prev: Readonly<Record<string, number>>,
  threshold: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const item of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    if (item.count <= threshold) continue;
    const prior = prev[item.file];
    next[item.file] = prior !== undefined ? Math.min(prior, item.count) : item.count;
  }
  return next;
}

export function nextLocBaseline(
  files: readonly FileCount[],
  prev: Readonly<Record<string, number>>,
  threshold: number = LOC_THRESHOLD,
): Record<string, number> {
  return nextCountBaseline(files, prev, threshold);
}

export function nextAnyBaseline(
  files: readonly FileCount[],
  prev: Readonly<Record<string, number>>,
): Record<string, number> {
  return nextCountBaseline(files, prev, 0);
}

export function nextCoverageFloors(summary: CoverageSummary, prev: CoverageFloors): CoverageFloors {
  const packages: Record<string, CoverageFloorMetric> = {};
  for (const pkg of Object.keys(summary.packages).sort()) {
    const measured = Math.floor(summary.packages[pkg]!.lines);
    const prior = prev.packages[pkg]?.lines;
    packages[pkg] = { lines: prior !== undefined ? Math.max(prior, measured) : measured };
  }
  return {
    global: { lines: Math.max(prev.global.lines, Math.floor(summary.global.lines)) },
    packages,
  };
}

export function formatVerdictSummary(verdict: GateVerdict): string {
  switch (verdict.kind) {
    case 'pass':
      return `[${verdict.gate}] OK`;
    case 'fail': {
      if (verdict.gate === 'coverage') {
        const rows = verdict.regressions.map((r) => `  REGRESSED ${r.key}: ${r.current}% < floor ${r.allowed}%`);
        return `[coverage] FAIL\n${rows.join('\n')}`;
      }
      const news = verdict.newOffenders.map((o) =>
        'complexity' in o ? `  NEW ${o.file}:${o.line} ${o.name} (CC=${o.complexity})` : `  NEW ${o.file} (${o.count})`,
      );
      const grew = verdict.grewOffenders.map((g) => `  GREW ${g.key}: ${g.current} > baseline ${g.allowed}`);
      return `[${verdict.gate}] FAIL\n${[...news, ...grew].join('\n')}`;
    }
    default:
      return assertNever(verdict);
  }
}

export function walkProductionFiles(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') walk(full);
      } else if (!isExcludedProdFile(rel)) {
        results.push(full);
      }
    }
  };
  walk(path.join(rootDir, 'packages'));
  walk(path.join(rootDir, 'scripts'));
  return results.sort();
}

interface JestFileEntry {
  readonly lines?: { readonly total?: number; readonly covered?: number; readonly pct?: number };
  readonly branches?: { readonly total?: number; readonly covered?: number; readonly pct?: number };
}

function bucketForPath(rel: string): string | undefined {
  const match = rel.match(/^(packages\/[^/]+)\//);
  if (match) return match[1];
  return rel.startsWith('scripts/') ? 'scripts' : undefined;
}

function pctFromAcc(covered: number, total: number): number {
  return total > 0 ? Number(((covered / total) * 100).toFixed(2)) : 100;
}

interface BucketTotals {
  readonly lt: number;
  readonly lc: number;
  readonly bt: number;
  readonly bc: number;
}

function addEntryMetrics(prev: BucketTotals | undefined, entry: JestFileEntry): BucketTotals {
  const base = prev ?? { lt: 0, lc: 0, bt: 0, bc: 0 };
  return {
    lt: base.lt + (entry.lines?.total ?? 0),
    lc: base.lc + (entry.lines?.covered ?? 0),
    bt: base.bt + (entry.branches?.total ?? 0),
    bc: base.bc + (entry.branches?.covered ?? 0),
  };
}

export function parseJestCoverageSummary(
  raw: Readonly<Record<string, JestFileEntry>>,
  rootDir: string,
): CoverageSummary {
  const totals = new Map<string, BucketTotals>();
  for (const [key, entry] of Object.entries(raw)) {
    const bucket = key === 'total' ? undefined : bucketForPath(path.relative(rootDir, key).split(path.sep).join('/'));
    if (bucket) totals.set(bucket, addEntryMetrics(totals.get(bucket), entry));
  }
  const packages: Record<string, CoverageMetric> = {};
  for (const [bucket, acc] of totals) {
    packages[bucket] = { lines: pctFromAcc(acc.lc, acc.lt), branches: pctFromAcc(acc.bc, acc.bt) };
  }
  return {
    global: { lines: raw.total?.lines?.pct ?? 0, branches: raw.total?.branches?.pct ?? 0 },
    packages,
  };
}

function loadJson<T>(filePath: string, fallback: T): T {
  return fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as T) : fallback;
}

function writeJson(filePath: string, data: unknown): number {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return 0;
}

function reportVerdict(verdict: GateVerdict): number {
  console.log(formatVerdictSummary(verdict));
  return verdict.kind === 'pass' ? 0 : 1;
}

function runCoverageCli(rootDir: string, scriptsDir: string, update: boolean): number {
  const summaryPath = path.join(rootDir, 'coverage', 'coverage-summary.json');
  const floorsPath = path.join(scriptsDir, 'coverage-floors.json');
  if (!fs.existsSync(summaryPath)) {
    console.error('Missing coverage/coverage-summary.json; run jest with --coverage --coverageReporters=json-summary');
    return 1;
  }
  const raw = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Record<string, JestFileEntry>;
  const summary = parseJestCoverageSummary(raw, rootDir);
  const floors = loadJson<CoverageFloors>(floorsPath, { global: { lines: 90 }, packages: {} });
  return update
    ? writeJson(floorsPath, nextCoverageFloors(summary, floors))
    : reportVerdict(evaluateCoverageRatchet(summary, floors));
}

export function runCli(rootDir: string, argv: readonly string[]): number {
  const gate = argv[0] as GateName | undefined;
  const update = argv.includes('--update');
  const scriptsDir = path.join(rootDir, 'scripts');
  if (gate === 'coverage') return runCoverageCli(rootDir, scriptsDir, update);

  const files = walkProductionFiles(rootDir).map((f) => ({
    rel: path.relative(rootDir, f).split(path.sep).join('/'),
    content: fs.readFileSync(f, 'utf8'),
  }));
  if (gate === 'loc') {
    const filePath = path.join(scriptsDir, 'loc-baseline.json');
    const counts = files.map((f) => ({ file: f.rel, count: countLinesInContent(f.content) }));
    const base = loadJson<Record<string, number>>(filePath, {});
    return update ? writeJson(filePath, nextLocBaseline(counts, base)) : reportVerdict(evaluateLocRatchet(counts, base));
  }
  if (gate === 'complexity') {
    const filePath = path.join(scriptsDir, 'cc-baseline.json');
    const units = files.flatMap((f) => analyzeFunctionsInSource(f.content, f.rel));
    const base = loadJson<Record<string, number>>(filePath, {});
    return update
      ? writeJson(filePath, nextComplexityBaseline(units, base))
      : reportVerdict(evaluateComplexityRatchet(units, base));
  }
  if (gate === 'any') {
    const filePath = path.join(scriptsDir, 'any-baseline.json');
    const counts = files.map((f) => ({ file: f.rel, count: countAnyInContent(f.content, f.rel) }));
    const base = loadJson<Record<string, number>>(filePath, {});
    return update ? writeJson(filePath, nextAnyBaseline(counts, base)) : reportVerdict(evaluateAnyRatchet(counts, base));
  }
  console.error('Usage: node scripts/quality-gates.ts <loc|complexity|any|coverage> [--update]');
  return 1;
}

if (process.argv[1]?.endsWith('quality-gates.ts')) {
  process.exit(runCli(process.cwd(), process.argv.slice(2)));
}
