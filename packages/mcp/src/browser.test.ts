import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { openBrowser } from './browser';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const spawnMock = jest.mocked(spawn);
const LINK = 'https://app.cancore.app/wallet/authorize?code=ABCD&calc';

function fakeChild(): EventEmitter & { unref: jest.Mock } {
  return Object.assign(new EventEmitter(), { unref: jest.fn() });
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeChild() as never);
});

// BUG-1618: through cmd.exe, a `&` in the link ends the command and runs what follows it.
test.each([
  ['win32', 'rundll32', ['url.dll,FileProtocolHandler', LINK]],
  ['darwin', 'open', [LINK]],
  ['linux', 'xdg-open', [LINK]],
])('on %s the link goes to %s as one argument, never through a shell', async (platform, command, args) => {
  await expect(openBrowser(LINK, platform as NodeJS.Platform)).resolves.toBe(true);

  expect(spawnMock).toHaveBeenCalledTimes(1);
  expect(spawnMock).toHaveBeenCalledWith(command, args, expect.objectContaining({ shell: false }));
});

test('a launcher that cannot start answers false', async () => {
  spawnMock.mockImplementation(() => {
    throw new Error('ENOENT');
  });

  await expect(openBrowser(LINK, 'linux')).resolves.toBe(false);
});

// An EventEmitter throws on an 'error' nobody listens to: that would take the whole server down.
test('a launcher that fails after starting does not crash the server', async () => {
  const child = fakeChild();
  spawnMock.mockReturnValue(child as never);

  await openBrowser(LINK, 'linux');

  expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
  expect(child.unref).toHaveBeenCalled();
});
