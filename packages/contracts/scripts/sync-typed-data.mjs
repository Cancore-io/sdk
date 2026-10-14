#!/usr/bin/env node
// Pull the EIP-712 schemas the Cancore contracts verify signatures over out of a
// checkout of Cancore-io/evm-contracts (abi/typed-data/*.json) and write this
// package's copy: the JSON, golden vectors included, under spec/typed-data/, and
// the types as `as const` TypeScript under src/generated/typedData.ts.
//
// This is the typed-data phase of full `npm run sync`; releases must run both
// scripts so ABI and schema provenance share one source. Nothing is edited by hand.
//
//   EVM_CONTRACTS_DIR=../evm-contracts npm run sync
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import render from './render.cjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const src = resolve(process.env.EVM_CONTRACTS_DIR ?? resolve(pkg, '../../../evm-contracts'), 'abi', 'typed-data');

const files = readdirSync(src).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) throw new Error(`no typed-data schemas under ${src}`);
mkdirSync(join(pkg, 'spec', 'typed-data'), { recursive: true });

const entries = [];
for (const file of files) {
  const schema = JSON.parse(readFileSync(join(src, file), 'utf8'));
  copyFileSync(join(src, file), join(pkg, 'spec', 'typed-data', file)); // byte-identical by construction
  entries.push([file, schema]);
}
writeFileSync(
  join(pkg, 'src', 'generated', 'typedData.ts'),
  render.renderTypedData(entries),
);
console.log(`synced ${files.length} typed-data schema(s) from ${src}`);
