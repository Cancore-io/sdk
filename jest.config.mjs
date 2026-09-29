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
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/packages/wallet/src/web/', '\\.int\\.test\\.ts$'],
  testMatch: ['**/*.test.ts'],
  transform,
  moduleNameMapper,
};

/**
 * Integration: the mock gateway as a real process (its CLI, from `dist/`) and a
 * real WebSocket client. Needs `npm run build` first, so it is its own project
 * and its own script (`npm run test:int`), never part of `npm test`.
 */
const intProject = {
  displayName: 'int',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['**/*.int.test.ts'],
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
  projects: [nodeProject, webProject, intProject],
  collectCoverageFrom: ['packages/*/src/**/*.ts', '!packages/*/src/**/*.test.ts'],
};
