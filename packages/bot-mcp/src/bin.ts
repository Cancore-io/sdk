#!/usr/bin/env node
import { startServer } from './index';

await startServer({ socketPath: process.env.CANCORE_BOTD_SOCKET ?? '/run/cancore-botd/botd.sock' });
