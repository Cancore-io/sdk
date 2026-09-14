/**
 * `@cancore/contracts/abi` — the deployed contracts' ABIs, `as const`, so
 * viem/wagmi infer function and event types from them.
 *
 * Every array here is generated from `Cancore-io/evm-contracts/abi/*.json`,
 * the reviewed snapshots that repository keeps in lock-step with its compiled
 * contracts (`abi:check` there). `npm run sync` in this package refreshes them;
 * a test holds the TypeScript to the JSON snapshot under `spec/abi/`.
 */
export * from './generated/index';
export * from './generated/errors';
