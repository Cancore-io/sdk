#!/usr/bin/env node
import { createRequire } from 'node:module';
import { resolveSocketPath, startServer } from './index';

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

await startServer({ socketPath: resolveSocketPath(process.argv.slice(2), process.env), version });
