/**
 * Plain node, no jsdom: this package touches no DOM API it does not receive as
 * a seam (`win`, `fetchImpl`, `openStream`), which is exactly what makes it
 * testable without a browser. If a test here ever needs jsdom, the seam it is
 * reaching around is the thing to fix.
 *
 * `.mjs` and not `.ts`: a TypeScript jest config costs a `ts-node` dependency
 * to read four lines of settings.
 *
 * @type {import('jest').Config}
 */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.ts$': ['@swc/jest', { jsc: { target: 'es2022' } }] },
  collectCoverageFrom: ['packages/*/src/**/*.ts', '!packages/*/src/**/*.test.ts'],
};
