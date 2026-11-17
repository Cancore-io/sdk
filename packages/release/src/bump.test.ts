import { bumpVersion, parseBumpLevel, parseConventionalBump, resolveBumpSignal } from './bump';
import type { BumpLevel } from './bump';

// Parity table: the same cases CAEF's scripts/agent-session/lib/ring-bump-signal.test.ts runs, so the rule
// cannot drift between the harness and the five Cancore repos. The only intended difference is the trailer
// name: `Release-Bump:` here, `Ring-Bump:` still accepted (CAN-3594 D5).
describe('parseBumpLevel: the trailer', () => {
  it.each<[string, string, BumpLevel]>([
    ['Release-Bump minor', 'fix(x): y\n\nbody text\n\nRelease-Bump: minor\n', 'minor'],
    ['Release-Bump, any case', 'fix(x): y\n\nRELEASE-BUMP: Major\n', 'major'],
    ['Release-Bump patch', 'fix(x): y\n\nrelease-bump: patch\n', 'patch'],
    ['Ring-Bump is still accepted (D5)', 'fix(x): y\n\nRing-Bump: minor\n', 'minor'],
  ])('%s', (_name, message, level) => {
    expect(parseBumpLevel(message)).toBe(level);
  });

  it.each([
    ['no trailer', 'fix(x): y\n\nno trailer here\n'],
    ['an invalid level is rejected, not guessed', 'fix(x): y\n\nRelease-Bump: huge\n'],
    ['a look-alike key does not match', 'fix(x): y\n\nRelease-Bumpy: minor\n'],
  ])('null: %s', (_name, message) => {
    expect(parseBumpLevel(message)).toBeNull();
  });
});

describe('parseConventionalBump', () => {
  it.each<[string, BumpLevel | null]>([
    ['feat!: drop the v1 order endpoint', 'major'],
    ['fix(orders)!: reject an empty memo', 'major'],
    ['feat(orders!): reject an empty memo', 'major'],
    ['chore: cleanup\n\nBREAKING CHANGE: manifest removed', 'major'],
    ['chore: cleanup\n\nBREAKING-CHANGE: manifest removed', 'major'],
    ['feat(skills): add release skill', 'minor'],
    ['✨ feat: emoji prefixed feature', 'minor'],
    ['fix(guard): handle detached head', 'patch'],
    ['docs: archive changelog', 'patch'],
    ['refactor: split the module', 'patch'],
    ['wip untyped commit', null],
    ['Merge pull request #1 from x/y', null],
  ])('%j -> %s', (message, level) => {
    expect(parseConventionalBump(message)).toBe(level);
  });
});

describe('bumpVersion', () => {
  it.each([
    ['5.0.0', 'patch', '5.0.1'],
    ['5.0.0', 'minor', '5.1.0'],
    ['5.1.2', 'major', '6.0.0'],
    ['1.4.2', 'minor', '1.5.0'],
    ['1.4.2', 'patch', '1.4.3'],
  ] as const)('%s + %s = %s', (current, level, next) => {
    expect(bumpVersion(current, level)).toBe(next);
  });

  // @edge: a breaking change on 1.4.2 releases 2.0.0, never 2.4.2 or 2.4.0.
  it('major resets minor and patch', () => {
    expect(bumpVersion('1.4.2', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.4.2', 'minor')).toBe('1.5.0');
  });

  it.each(['not-a-version', '1.4', 'v1.4.2', '1.4.2-dev.1'])('rejects %j rather than guessing', (bad) => {
    expect(() => bumpVersion(bad, 'patch')).toThrow(/invalid/i);
  });
});

describe('resolveBumpSignal', () => {
  it('a Release-Bump trailer beats the conventional commits, whatever their order', () => {
    const signal = resolveBumpSignal([
      'feat(a)!: breaking by subject',
      'fix(b): small\n\nWhy minor: new optional field.\n\nRelease-Bump: minor\n',
    ]);
    expect(signal).toEqual({ level: 'minor', rationale: 'Why minor: new optional field.', defaulted: false });
  });

  it('the highest trailer wins across commits', () => {
    const signal = resolveBumpSignal([
      'feat(a): x\n\nRelease-Bump: patch\n',
      'feat(a): y\n\nMajor shift.\n\nRelease-Bump: major\n',
      'feat(a): z\n\nRing-Bump: minor\n',
    ]);
    expect(signal).toMatchObject({ level: 'major', rationale: 'Major shift.', defaulted: false });
  });

  it('without a trailer the highest conventional commit decides: feat! > feat > fix', () => {
    expect(resolveBumpSignal(['fix: a', 'feat: b', 'feat(c)!: d']).level).toBe('major');
    expect(resolveBumpSignal(['fix: a', 'feat: b']).level).toBe('minor');
    expect(resolveBumpSignal(['fix: a', 'docs: b']).level).toBe('patch');
  });

  it('a BREAKING CHANGE footer on a non-feat commit makes it major', () => {
    expect(resolveBumpSignal(['fix(api): rename a field\n\nBREAKING CHANGE: `memo` is now `note`']).level).toBe('major');
  });

  it('nothing declared: patch, flagged as defaulted', () => {
    const signal = resolveBumpSignal(['wip a\n\nbody\n', 'wip b\n']);
    expect(signal.level).toBe('patch');
    expect(signal.defaulted).toBe(true);
    expect(signal.rationale).toMatch(/defaulted to PATCH/);
  });

  it('an empty range defaults to patch too', () => {
    expect(resolveBumpSignal([])).toMatchObject({ level: 'patch', defaulted: true });
  });
});

describe('resolveBumpSignal: rationale fallbacks', () => {
  it('a bare trailer says it carried no rationale', () => {
    expect(resolveBumpSignal(['fix: x\n\nRelease-Bump: minor\n']).rationale).toMatch(/no rationale/);
  });

  it('a bodiless conventional commit quotes its subject', () => {
    expect(resolveBumpSignal(['feat(api): add a field']).rationale).toBe('feat(api): add a field');
  });

  it('CRLF messages read the same as LF', () => {
    expect(resolveBumpSignal(['chore: x\r\n\r\nBREAKING CHANGE: gone\r\n']).level).toBe('major');
  });
});
