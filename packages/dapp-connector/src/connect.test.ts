import { runConnectCeremony } from './connect';
import { RpcCode, type MessageEventLike, type PopupLike, type WindowLike } from './types';

const HOST = 'https://app-dev.cancore.app';

const GRANT = {
  type: 'cancore:connect-result',
  token: 'cs_grant',
  origin: 'https://dapp.example',
  scopes: ['wallet:connect'],
  expiresAt: '2026-09-01T00:00:00.000Z',
  rpcUrl: 'https://api-dev.cancore.app/dapp/rpc',
};

function harness(popupBlocked = false) {
  const posts: Array<{ message: unknown; targetOrigin: string }> = [];
  let listener: ((event: MessageEventLike) => void) | null = null;

  const popup: PopupLike & { closed: boolean } = {
    closed: false,
    postMessage: (message, targetOrigin) => posts.push({ message, targetOrigin }),
    close: () => {
      popup.closed = true;
    },
  };

  const opened: string[] = [];
  const win: WindowLike = {
    open: (url) => {
      opened.push(url);
      return popupBlocked ? null : popup;
    },
    addEventListener: (_type, handler) => {
      listener = handler;
    },
    removeEventListener: () => {
      listener = null;
    },
  };

  return {
    win,
    popup,
    posts,
    opened,
    deliver: (data: unknown, from: { origin?: string; source?: unknown } = {}) =>
      listener?.({ origin: from.origin ?? HOST, source: from.source ?? popup, data }),
    listening: () => listener !== null,
  };
}

function ceremony(win: WindowLike) {
  return runConnectCeremony({ host: HOST, appName: 'Test dApp', scopes: ['wallet:connect'], win });
}

describe('the dApp half of the consent ceremony', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('opens the consent page and keeps asking until it is answered', async () => {
    const h = harness();
    const running = ceremony(h.win);

    expect(h.opened).toEqual([`${HOST}/connect`]);
    expect(h.posts[0]).toEqual({
      message: { type: 'cancore:connect-request', appName: 'Test dApp', scopes: ['wallet:connect'] },
      targetOrigin: HOST,
    });
    jest.advanceTimersByTime(1000);
    expect(h.posts.length).toBeGreaterThan(1);

    h.deliver(GRANT);
    await expect(running).resolves.toEqual({
      token: 'cs_grant',
      rpcUrl: 'https://api-dev.cancore.app/dapp/rpc',
      scopes: ['wallet:connect'],
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    expect(h.listening()).toBe(false);
  });

  // The token is a bearer credential. Neither test below is a formality.
  it('ignores a grant that did not come from the wallet origin', async () => {
    const h = harness();
    const running = ceremony(h.win);

    h.deliver(GRANT, { origin: 'https://phish.example' });
    jest.advanceTimersByTime(1000);
    h.deliver(GRANT);

    await expect(running).resolves.toMatchObject({ token: 'cs_grant' });
  });

  it('ignores a grant from a window other than the one it opened', async () => {
    const h = harness();
    const running = ceremony(h.win);

    h.deliver({ ...GRANT, token: 'cs_attacker' }, { source: { other: true } });
    h.deliver(GRANT);

    await expect(running).resolves.toMatchObject({ token: 'cs_grant' });
  });

  it('ignores anything that is not a result frame', async () => {
    const h = harness();
    const running = ceremony(h.win);

    h.deliver(null);
    h.deliver('hello');
    h.deliver({ type: 'something-else', token: 'cs_x' });
    h.deliver({ ...GRANT, scopes: [1, 'wallet:connect'], expiresAt: 7 });

    await expect(running).resolves.toEqual({
      token: 'cs_grant',
      rpcUrl: 'https://api-dev.cancore.app/dapp/rpc',
      scopes: ['wallet:connect'],
      expiresAt: '',
    });
  });

  // The wallet answers once. A result frame we cannot spend is the end of the
  // ceremony, not something to keep waiting through — the alternative is a
  // popup that sits there until the five-minute timeout with nothing coming.
  it.each([
    ['no token', { ...GRANT, token: '' }],
    ['no rpcUrl', { ...GRANT, rpcUrl: undefined }],
  ])('gives up on a result frame with %s', async (_name, frame) => {
    const h = harness();
    const running = ceremony(h.win);

    h.deliver(frame);

    await expect(running).rejects.toMatchObject({ code: RpcCode.USER_REJECTED });
  });

  it('surfaces the refusal code the wallet sent', async () => {
    const h = harness();
    const running = ceremony(h.win);

    h.deliver({ type: 'cancore:connect-result', error: { code: 4001, message: 'User rejected the request' } });

    await expect(running).rejects.toEqual({ code: 4001, message: 'User rejected the request' });
  });

  it('treats a malformed refusal as a refusal', async () => {
    const h = harness();
    const running = ceremony(h.win);

    h.deliver({ type: 'cancore:connect-result' });

    await expect(running).rejects.toMatchObject({ code: RpcCode.USER_REJECTED });
  });

  it('gives up when the user closes the window', async () => {
    const h = harness();
    const running = ceremony(h.win);

    h.popup.closed = true;
    jest.advanceTimersByTime(500);

    await expect(running).rejects.toMatchObject({ code: RpcCode.USER_REJECTED });
  });

  it('gives up, and closes the window, when nobody answers', async () => {
    const h = harness();
    const running = ceremony(h.win);

    jest.advanceTimersByTime(5 * 60 * 1000);

    await expect(running).rejects.toMatchObject({ code: RpcCode.RESOURCE_UNAVAILABLE });
    expect(h.popup.closed).toBe(true);
  });

  it('says so when the browser blocks the window', async () => {
    const h = harness(true);

    await expect(ceremony(h.win)).rejects.toMatchObject({ code: RpcCode.DISCONNECTED });
  });
});
