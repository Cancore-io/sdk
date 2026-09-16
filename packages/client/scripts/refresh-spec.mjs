// Pull the deployed gateway's OpenAPI document into spec/openapi.json.
//
// Written with sorted keys and one field per line, so a refresh that changes
// nothing in the API changes nothing on disk, and one that does reads as a
// reviewable diff instead of a single 350 KB line. Arrays keep their order:
// `required`, `enum` and `parameters` come out of the backend code in a fixed
// order, and sorting them would rewrite the document rather than normalize it.
import { writeFileSync } from 'node:fs';

const url = 'https://api-dev.cancore.app/api-json';
const out = new URL('../spec/openapi.json', import.meta.url);

const res = await fetch(url);
if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
const doc = await res.json();
// An error page or a half-booted stand must fail the refresh, not replace the snapshot.
if (typeof doc?.openapi !== 'string' || Object.keys(doc.paths ?? {}).length === 0) {
  throw new Error(`${url} did not return an OpenAPI document with paths`);
}

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;

writeFileSync(out, `${JSON.stringify(sortKeys(doc), null, 2)}\n`);
console.log(Object.keys(doc.paths).length, 'paths');
