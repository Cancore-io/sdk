#!/usr/bin/env node
import { main } from './cli';

const result = await main(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
