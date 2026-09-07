import { base64UrlToBuffer, bufferToBase64Url, toUint8Array, type Bytes } from '../bytes';
import type { RegisterResult } from '../types';

/**
 * WebAuthn/PRF calls for the production passkey wallet, ported from the
 * proven PoC (poc/passkey/lib/webauthn.ts). `rpId` and the passkey user
 * label are supplied by the caller — this module has no opinion on identity,
 * only on the create()/get() ceremonies.
 */

const RP_NAME = 'Cancore';

export function isWebAuthnSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

/** Register a new passkey with the PRF extension requested (create ceremony). */
export async function registerPasskey(rpId: string, userName: string): Promise<RegisterResult> {
  if (!isWebAuthnSupported()) throw new Error('WebAuthn is not supported in this browser');

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: RP_NAME },
      user: { id: userId, name: userName, displayName: userName },
      challenge,
      // -8 = EdDSA/Ed25519, -7 = ES256 fallback for authenticators without Ed25519 support.
      pubKeyCredParams: [
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -7 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: {} },
      timeout: 60_000,
    },
  });

  if (!credential || !('rawId' in credential)) {
    throw new Error('No credential returned (user cancelled or authenticator declined)');
  }
  const publicKeyCredential = credential as PublicKeyCredential;
  const extensionResults = publicKeyCredential.getClientExtensionResults();
  const response = publicKeyCredential.response as AuthenticatorAttestationResponse;

  return {
    credentialIdB64Url: bufferToBase64Url(publicKeyCredential.rawId),
    prfEnabled: Boolean(extensionResults.prf?.enabled),
    authenticatorAttachment: publicKeyCredential.authenticatorAttachment,
    transports: response.getTransports(),
  };
}

/**
 * Evaluate the PRF extension for an existing credential (get ceremony).
 * `salt` must be the same 32-byte value used at registration time to derive
 * a stable per-user secret — see `PersistedPasskeyWalletRecord.saltHex`.
 */
export async function evalPrf(
  credentialIdB64Url: string,
  rpId: string,
  salt: Bytes,
): Promise<Bytes> {
  if (!isWebAuthnSupported()) throw new Error('WebAuthn is not supported in this browser');

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = base64UrlToBuffer(credentialIdB64Url);

  const assertion = await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge,
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } },
    },
  });

  if (!assertion || !('rawId' in assertion)) {
    throw new Error('No assertion returned (user cancelled or authenticator declined)');
  }
  const publicKeyCredential = assertion as PublicKeyCredential;
  const extensionResults = publicKeyCredential.getClientExtensionResults();
  const output = extensionResults.prf?.results?.first;
  if (!output) {
    throw new Error('Authenticator did not return a PRF output (no PRF support on this credential)');
  }
  return toUint8Array(output);
}
