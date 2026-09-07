// jsdom gives the web entry a DOM but not the crypto it runs on: it exposes
// crypto.getRandomValues and no crypto.subtle, and no TextEncoder/TextDecoder
// (which @noble needs). Browsers provide all three natively — this file hands
// jsdom node's implementations so the tests exercise the real code paths.
//
// CommonJS: jest runs `setupFiles` through its CJS runtime, where an `import`
// statement is a syntax error.
const { webcrypto } = require('node:crypto');
const { TextDecoder, TextEncoder } = require('node:util');

if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
