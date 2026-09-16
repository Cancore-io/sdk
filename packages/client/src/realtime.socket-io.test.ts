import type { Socket } from 'socket.io-client';
import { orderUpdates, waitForOrder, type SocketLike } from './realtime';

/**
 * The README tells people to hand `orderUpdates` a socket they built with
 * `io(...)`. That sentence is a type claim, and a type claim in prose is the
 * kind that rots quietly — `socket.io-client` gets to change its listener
 * signatures, and the first person to find out would be a stranger whose build
 * stops compiling against a package whose npm page says it works.
 *
 * So the claim is compiled. `socket.io-client` is a devDependency here and a
 * type-only import (erased at runtime, nothing to load, nothing shipped): the
 * package still has no dependencies, runtime or peer, and nobody installing it
 * needs socket.io-client unless they want a socket.
 *
 * `tsc` is the assertion — `npm run typecheck` covers this file. The runtime
 * test below only keeps jest from calling the file empty.
 */
declare const socket: Socket;

/** Never called. Every line in it is an assertion `tsc` makes and jest cannot. */
export function compiles(): () => void {
  // The claim: socket.io-client's own Socket is a SocketLike, no adapter.
  const injected: SocketLike = socket;
  void injected;
  // And it goes straight into both functions, the payload typed on the way out.
  void waitForOrder(socket, 'o1');
  return orderUpdates(socket, (order) => void order.status);
}

test('socket.io-client Socket satisfies SocketLike (the assertion is the compile, not this)', () => {
  expect(typeof compiles).toBe('function');
});
