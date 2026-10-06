/**
 * Two projects, because the wallet's browser entry is the one place in this
 * repository that legitimately needs a DOM.
 *
 * `.mjs` and not `.ts`: a TypeScript jest config costs a `ts-node` dependency
 * to read a few lines of settings.
 *
 * @type {import('jest').Config}
 */
const transform = { '^.+\\.ts$': ['@swc/jest', { jsc: { target: 'es2022' } }] };

// A package importing a sibling tests against the sibling's source: `dist/`
// does not exist until the build, which runs after the tests.
const moduleNameMapper = {
  '^@cancore/wallet$': '<rootDir>/packages/wallet/src/index.ts',
  '^@cancore/wallet/operations$': '<rootDir>/packages/wallet/src/operations.ts',
  '^@cancore/contracts$': '<rootDir>/packages/contracts/src/index.ts',
};

/**
 * Everything except the wallet's `./web` entry, in plain node with no setup
 * file. Keeping this project setup-free is what proves the wallet core and the
 * connector are runtime-agnostic: the moment either needs a browser shim, the
 * extraction has failed and the CLI/MCP consumer (CAN-612) is blocked again.
 */
const nodeProject = {
  displayName: 'node',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/packages/wallet/src/web/'],
  testMatch: ['**/*.test.ts'],
  transform,
  moduleNameMapper,
};

/** `@cancore/wallet/web` — IndexedDB and WebAuthn, which only exist in a browser. */
const webProject = {
  displayName: 'web',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/packages/wallet/src/web'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/jest.setup.web.cjs'],
  transform,
};

export default {
  projects: [nodeProject, webProject],
  collectCoverageFrom: ['packages/*/src/**/*.ts', '!packages/*/src/**/*.test.ts'],
};
