/**
 * Two projects, because the wallet's browser entry is the one place in this
 * repository that legitimately needs a DOM.
 *
 * `.mjs` and not `.ts`: a TypeScript jest config costs a `ts-node` dependency
 * to read a few lines of settings.
 *
 * @type {import('jest').Config}
 */
const swc = ['@swc/jest', { jsc: { target: 'es2022' } }];
// noble v2 and scure v2 ship ESM only and jest runs CommonJS, so @noble/* and @scure/* are the only
// dependencies swc transpiles; every other package under node_modules stays as published (CAN-3207).
const transform = { '^.+\\.ts$': swc, '/node_modules/(\\.pnpm/[^/]+/node_modules/)?@(noble|scure)/.+\\.js$': swc };
const transformIgnorePatterns = ['/node_modules/(?!(\\.pnpm/@(noble|scure)\\+[^/]+/node_modules/)?@(noble|scure)/)'];

// A package importing a sibling tests against the sibling's source: `dist/`
// does not exist until the build, which runs after the tests.
const moduleNameMapper = {
  '^@cancore/wallet$': '<rootDir>/packages/wallet/src/index.ts',
  '^@cancore/wallet/operations$': '<rootDir>/packages/wallet/src/operations.ts',
  '^@cancore/wallet/canton$': '<rootDir>/packages/wallet/src/canton/index.ts',
  '^@cancore/wallet/canton/proto$': '<rootDir>/packages/wallet/src/canton/proto.ts',
  '^@cancore/contracts$': '<rootDir>/packages/contracts/src/index.ts',
  '^@cancore/client/selfcustody$': '<rootDir>/packages/client/src/selfcustody.ts',
  '^@cancore/trader/filler/canton/hashing$': '<rootDir>/packages/trader/src/filler/canton/hashing.ts',
  '^@cancore/botd/protocol$': '<rootDir>/packages/botd/src/protocol/index.ts',
  '^@cancore/botd/ipc/client$': '<rootDir>/packages/botd/src/ipc/client.ts',
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
  transformIgnorePatterns,
  moduleNameMapper,
};

/**
 * Integration: suites against a real local stand (e.g. `@cancore/trader`'s
 * RouterReader against the stand's CancoreRouter). They skip themselves
 * without the stand's artifacts, so this is its own project and its own
 * script (`npm run test:int`), never part of `npm test`.
 */
const intProject = {
  displayName: 'int',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['**/*.int.test.ts'],
  transform,
  transformIgnorePatterns,
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
  transformIgnorePatterns,
};

export default {
  projects: [nodeProject, webProject, intProject],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    'scripts/*.ts',
    '!packages/*/src/**/*.test.ts',
    '!packages/contracts/src/generated/**',
  ],
};
