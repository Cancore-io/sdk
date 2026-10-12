#!/usr/bin/env node
// Pull the canonical ABI snapshots out of a checkout of Cancore-io/evm-contracts
// and write this package's data from them: the JSON snapshot under spec/, the
// `as const` TypeScript under src/generated/, the custom-error selector tables,
// and the release identity (version, source commit, bytecode hashes).
//
// The contracts repository is the source of truth; this package is a mirror an
// integrator can install. Nothing here is edited by hand — re-run the sync.
//
// Two source directories. abi/ holds the snapshots evm-contracts extracts from
// its own artifacts (bare ABI arrays); vendor/ holds ABIs built elsewhere — CNRX
// and IBurnMintERC20 from cancore-token-evm — as objects whose `.abi` is the
// array (CAN-1789). abi/ also carries two manifests that are not ABIs.
//
// It also reads the public constants of CancoreRouter and AttestorSet out of
// their Solidity source into spec/constants.json, so a test holds the
// package's constants to the contract's (SDK-6).
//
//   EVM_CONTRACTS_DIR=../evm-contracts npm run sync
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import render from './render.cjs';

const { renderAbiModule, renderErrors, renderIndex } = render;

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const src = resolve(process.env.EVM_CONTRACTS_DIR ?? resolve(pkg, '../../../evm-contracts'));

// CONTRACTS_RELEASE names the evm-contracts commit the data came from, read from
// the checkout itself and nowhere else: a directory that is not the root of a git
// checkout, or one with uncommitted changes, is refused before anything is read,
// so the release can never be stamped with a commit its data did not come from.
const git = (...args) => {
  try {
    return execFileSync('git', ['-C', src, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
};
const top = git('rev-parse', '--show-toplevel');
if (top === null || realpathSync(top) !== realpathSync(src)) {
  throw new Error(`${src} is not the root of a git checkout of evm-contracts; sync from a checkout`);
}
const dirty = git('status', '--porcelain');
if (dirty === null || dirty !== '') throw new Error(`${src} has uncommitted changes; sync from a clean checkout`);
const commit = git('rev-parse', 'HEAD');

const abiDir = join(src, 'abi');
const vendorDir = join(src, 'vendor');
const MANIFESTS = new Set(['bytecode-hashes.json', 'versions.json']);
const jsonNames = (dir, skip = new Set()) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && !skip.has(f)).map((f) => f.replace(/\.json$/, '')) : [];

/** name → where its ABI lives; a name in both directories is refused rather than silently shadowed. */
const sources = new Map();
for (const name of jsonNames(abiDir, MANIFESTS)) sources.set(name, { path: `abi/${name}.json`, pick: (json) => json });
for (const name of jsonNames(vendorDir)) {
  if (sources.has(name)) throw new Error(`${name}.json is in both abi/ and vendor/`);
  sources.set(name, { path: `vendor/${name}.json`, pick: (json) => json.abi });
}
const names = [...sources.keys()].sort();
if (names.length === 0) throw new Error(`no ABI snapshots under ${abiDir}`);

// The sync writes files and deletes none, so a contract that left the source
// would keep its snapshot on disk while dropping out of index.ts — a lost export
// nobody sees. Refuse instead; removing one is a decision, not a side effect.
const orphans = jsonNames(join(pkg, 'spec', 'abi')).filter((name) => !sources.has(name));
if (orphans.length > 0) throw new Error(`spec/abi has snapshots the source no longer has: ${orphans.join(', ')}`);

const version = JSON.parse(readFileSync(join(src, 'version.json'), 'utf8'));
const bytecode = JSON.parse(readFileSync(join(abiDir, 'bytecode-hashes.json'), 'utf8'));

mkdirSync(join(pkg, 'spec', 'abi'), { recursive: true });
mkdirSync(join(pkg, 'src', 'generated'), { recursive: true });

const abis = names.map((name) => {
  const { path, pick } = sources.get(name);
  const abi = pick(JSON.parse(readFileSync(join(src, path), 'utf8')));
  if (!Array.isArray(abi)) throw new Error(`${name}: not an ABI array`);
  return [name, abi, path];
});
for (const [name, abi, path] of abis) {
  writeFileSync(join(pkg, 'spec', 'abi', `${name}.json`), `${JSON.stringify(abi, null, 2)}\n`);
  writeFileSync(join(pkg, 'src', 'generated', `${name}.ts`), renderAbiModule(name, abi, path));
}
writeFileSync(join(pkg, 'src', 'generated', 'errors.ts'), renderErrors(abis));
// The manifest's field names read as keccak256 / byte counts; BUILD_HASHES renames them
// to what they are. A field missing from the manifest is refused, not passed through.
const FIELDS = {
  bytecodeHash: 'creationHexSha256',
  deployedBytecodeHash: 'runtimeHexSha256',
  bytecodeLength: 'creationHexLength',
  deployedBytecodeLength: 'runtimeHexLength',
};
const buildHashes = Object.fromEntries(
  Object.entries(bytecode).map(([name, entry]) => [
    name,
    Object.fromEntries(
      Object.entries(FIELDS).map(([from, to]) => {
        if (!(from in entry)) throw new Error(`bytecode-hashes.json: ${name} has no ${from}`);
        return [to, entry[from]];
      }),
    ),
  ]),
);
writeFileSync(
  join(pkg, 'src', 'generated', 'meta.ts'),
  `// Generated by scripts/sync.mjs from evm-contracts/version.json and abi/bytecode-hashes.json.\n\n` +
    `/** The evm-contracts release these ABIs were taken from, and the commit of the checkout they were read at. */\n` +
    `export const CONTRACTS_RELEASE = ${JSON.stringify({ version: version.version, releaseChannel: version.releaseChannel, updatedAt: version.updatedAt, commit }, null, 2)} as const;\n\n` +
    `/**\n * Per contract, the build of the release, as evm-contracts\n * scripts/tools/check-bytecode-match.mjs records it. \`creationHexSha256\` and\n * \`runtimeHexSha256\` are sha256 of the UTF-8 text of the artifact's 0x-prefixed hex of the\n * creation and runtime bytecode (not keccak256, not of the bytes); \`creationHexLength\` and\n * \`runtimeHexLength\` are the length of that text including the 0x. It pins the build a\n * release was made from. It is not a hash of \`eth_getCode\` — a contract with immutables\n * (CancoreRouter, FeeVault) never matches one — so checking a live deployment against it\n * needs a rebuild, not a lookup.\n */\n` +
    `export const BUILD_HASHES = ${JSON.stringify(buildHashes, null, 2)} as const;\n\n` +
    `/**\n * @deprecated Use \`BUILD_HASHES\`: the same values under names that say what they are\n * (bytecodeHash → creationHexSha256, deployedBytecodeHash → runtimeHexSha256,\n * bytecodeLength → creationHexLength, deployedBytecodeLength → runtimeHexLength).\n * Kept for one release candidate; removed before 0.2.0.\n */\n` +
    `export const BYTECODE_HASHES = ${JSON.stringify(bytecode, null, 2)} as const;\n`,
);
writeFileSync(join(pkg, 'src', 'generated', 'index.ts'), renderIndex(names));

// The public constants, evaluated from the source text: integer literals (with `_`), time units,
// sums of earlier constants, string literals and keccak256 of a string literal. A numeric or
// string constant this cannot evaluate is refused; a bytes32 built any other way (a domain
// separator from abi.encode) is left out — the type hashes are what the package can check.
const CONSTANT_SOURCES = { CancoreRouter: 'contracts/CancoreRouter.sol', AttestorSet: 'contracts/lib/AttestorSet.sol' };
const UNITS = { seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n, weeks: 604800n };
const LITERALS = /^(?:"[^"\\]*"\s*)+$/;
const literal = (text) => [...text.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]).join('');
const constants = {};
for (const [contract, path] of Object.entries(CONSTANT_SOURCES)) {
  const source = readFileSync(join(src, path), 'utf8');
  const out = {};
  for (const [, type, name, raw] of source.matchAll(/\b(uint\d*|string|bytes32)\s+public\s+constant\s+(\w+)\s*=\s*([^;]+);/g)) {
    const expr = raw.replace(/\s+/g, ' ').trim();
    const where = `${path}: ${name}`;
    if (type === 'string') {
      if (!LITERALS.test(expr)) throw new Error(`${where}: not a string literal`);
      out[name] = { type, value: literal(expr) };
    } else if (type === 'bytes32') {
      const hashed = /^keccak256\(\s*((?:"[^"\\]*"\s*)+)\)$/.exec(expr);
      if (hashed) out[name] = { type, value: `0x${bytesToHex(keccak_256(utf8ToBytes(literal(hashed[1]))))}` };
    } else {
      const value = expr.split('+').reduce((sum, term) => {
        const t = term.trim();
        const number = /^(\d[\d_]*)(?: (seconds|minutes|hours|days|weeks))?$/.exec(t);
        if (number) return sum + BigInt(number[1].replaceAll('_', '')) * (number[2] ? UNITS[number[2]] : 1n);
        if (out[t]?.type.startsWith('uint')) return sum + BigInt(out[t].value);
        throw new Error(`${where}: cannot evaluate ${JSON.stringify(t)}`);
      }, 0n);
      out[name] = { type, value: value.toString() };
    }
  }
  if (Object.keys(out).length === 0) throw new Error(`${path}: no public constants found`);
  constants[contract] = out;
}
writeFileSync(
  join(pkg, 'spec', 'constants.json'),
  `${JSON.stringify(
    {
      $comment: 'Public constants of CancoreRouter and AttestorSet, read by scripts/sync.mjs from their Solidity source at `commit` (the same checkout as the ABIs). Values are decimal strings for integers, the text for strings, the hash for keccak256 of a string literal. src/constants.test.ts holds the package\'s constants to this file (SDK-6). Not edited by hand.',
      commit,
      contracts: constants,
    },
    null,
    2,
  )}\n`,
);
console.log(`synced ${names.length} ABIs from ${src} (evm-contracts ${version.version})`);
