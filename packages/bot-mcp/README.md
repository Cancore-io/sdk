# `@cancore/bot-mcp`

```sh
npm install @cancore/bot-mcp
```

A stdio MCP server that lets an AI agent drive a local `cancore-botd` within the owner's limits. **Work in progress (CAN-2710).**

It can read state, reduce risk and trade within limits. It has no tool to withdraw, send, export a key, change limits, unlock or resume.

```ts
import { AGENT_METHODS } from '@cancore/bot-mcp';
```
