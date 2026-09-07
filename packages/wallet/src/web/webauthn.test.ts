import { isWebAuthnSupported, registerPasskey, evalPrf } from './webauthn';

describe('webauthn lib', () => {
  const originalPublicKeyCredential = global.PublicKeyCredential;
  const originalCredentials = navigator.credentials;

  afterEach(() => {
    (global as any).PublicKeyCredential = originalPublicKeyCredential;
    Object.defineProperty(navigator, 'credentials', {
      writable: true,
      value: originalCredentials,
    });
    jest.clearAllMocks();
  });

  it('checks if WebAuthn is supported', () => {
    (global as any).PublicKeyCredential = jest.fn();
    expect(isWebAuthnSupported()).toBe(true);

    delete (global as any).PublicKeyCredential;
    expect(isWebAuthnSupported()).toBe(false);
  });

  it('registers a passkey successfully', async () => {
    (global as any).PublicKeyCredential = jest.fn();

    const mockCredential = {
      rawId: new Uint8Array([1, 2, 3]).buffer,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({ prf: { enabled: true } }),
      response: {
        getTransports: () => ['internal'],
      },
    };

    Object.defineProperty(navigator, 'credentials', {
      writable: true,
      value: {
        create: jest.fn().mockResolvedValue(mockCredential),
      },
    });

    const result = await registerPasskey('cancore.io', 'alice@cancore.io');
    expect(result.prfEnabled).toBe(true);
    expect(result.authenticatorAttachment).toBe('platform');
    expect(result.transports).toEqual(['internal']);
  });

  it('throws error during registration if credential is null', async () => {
    (global as any).PublicKeyCredential = jest.fn();

    Object.defineProperty(navigator, 'credentials', {
      writable: true,
      value: {
        create: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(registerPasskey('cancore.io', 'alice@cancore.io')).rejects.toThrow(
      'No credential returned (user cancelled or authenticator declined)',
    );
  });

  it('evaluates PRF for an existing credential', async () => {
    (global as any).PublicKeyCredential = jest.fn();

    const prfOutput = new Uint8Array([10, 20, 30]).buffer;
    const mockAssertion = {
      rawId: new Uint8Array([1, 2, 3]).buffer,
      getClientExtensionResults: () => ({
        prf: { results: { first: prfOutput } },
      }),
    };

    Object.defineProperty(navigator, 'credentials', {
      writable: true,
      value: {
        get: jest.fn().mockResolvedValue(mockAssertion),
      },
    });

    const salt = new Uint8Array(32);
    const result = await evalPrf('AQID', 'cancore.io', salt);
    expect(result).toEqual(new Uint8Array([10, 20, 30]));
  });

  it('throws error in evalPrf if PRF output is missing', async () => {
    (global as any).PublicKeyCredential = jest.fn();

    const mockAssertion = {
      rawId: new Uint8Array([1, 2, 3]).buffer,
      getClientExtensionResults: () => ({ prf: {} }),
    };

    Object.defineProperty(navigator, 'credentials', {
      writable: true,
      value: {
        get: jest.fn().mockResolvedValue(mockAssertion),
      },
    });

    const salt = new Uint8Array(32);
    await expect(evalPrf('AQID', 'cancore.io', salt)).rejects.toThrow(
      'Authenticator did not return a PRF output',
    );
  });
});
