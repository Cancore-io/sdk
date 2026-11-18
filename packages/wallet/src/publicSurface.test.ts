import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import * as canton from './canton';
import * as proto from './canton/proto';
import * as root from './index';
import * as operations from './operations';

// Once published, every name here is a promise to someone else's code: a change to a list must be a
// deliberate edit of this file, never a side effect of an `export *` in a module behind the entry.
const SURFACE: Record<string, { module: Record<string, unknown>; names: string[] }> = {
  '.': {
    module: root,
    names: [
      'CANTON_DERIVATION_PATH', 'InvalidPrivateKeyError', 'KeyBindingError', 'LEGACY_WALLET_RECORD_VERSION', 'LOGIN_CHALLENGE_PREFIX',
      'MNEMONIC_LANGUAGES', 'MemoryKeyStore', 'PBKDF2_HASH', 'PBKDF2_ITERATIONS', 'WALLET_PASSWORD_MIN_LENGTH', 'WALLET_RECORD_VERSION',
      'WRAP_INFO', 'WrongPasswordError', 'assessWalletPassword', 'base64UrlToBuffer', 'binaryStringToBytes', 'bufferToBase64Url',
      'bytesToBinaryString', 'bytesToHex', 'cantonDerivationPath', 'cantonFingerprint', 'changeKeyPasswordWalletPassword',
      'createEd25519Signer', 'createPasskeySigningProvider', 'deriveCandidates', 'deriveKeyFromPassword', 'deriveRecordKeks',
      'deriveWalletKey', 'deriveWrappingKey', 'describeMnemonicError', 'detectMnemonicLanguage', 'ed25519PublicKeyFromSeed',
      'generateEd25519KeyPair', 'hexToBytes', 'importKeyPasswordWallet', 'importSubtleVerifyKey', 'isNoAccountError', 'isPartyOfKey',
      'isSubtleEd25519Supported', 'isValidMnemonic', 'keyOwnsParty', 'makeChallengeAccountProbe', 'matchPhraseToParty',
      'mnemonicToEd25519Seed', 'newMnemonic', 'normalizeMnemonic', 'partyNamespace', 'providerFromMnemonic', 'providerFromSeed',
      'resolveRestoredSeed', 'revealWalletSecret', 'signWithEd25519Signer', 'signWithSubtle', 'slip10DeriveEd25519', 'toUint8Array',
      'unlockKeyPasswordWallet', 'unwrapSeed', 'verifyEd25519', 'verifyWithSubtle', 'walletRecordVersion', 'wordlistFor', 'wrapSeed',
    ],
  },
  './operations': {
    module: operations,
    names: [
      'INTENT_OPERATIONS', 'IntentTransactionRefusedError', 'OperationDeclinedError', 'TOPOLOGY_OPERATION', 'UnexpectedLegError',
      'assertOperationLegs', 'base64ToBinaryString', 'configureWalletOperations', 'createWalletOperations', 'hexSignatureToBase64',
      'isIntentOperation', 'signLegs', 'signPreparedHashBase64', 'signPreparedTransaction', 'verifyPreparedTransaction', 'wallet',
    ],
  },
  './canton': {
    module: canton,
    names: [
      'CANTON_ALLOCATION_TEMPLATES', 'CANTON_TRANSFER_FACTORIES', 'INTENT_OPERATIONS', 'INTENT_PACKAGE_IDS', 'INTENT_PACKAGE_NAME',
      'INTENT_ROOTS', 'IntentTransactionRefusedError', 'REGISTRY_GUARDIANS', 'REGISTRY_PACKAGES', 'allocationTemplateOf',
      'checkIntentTransaction', 'holdingTemplateOf', 'holdingTemplatesOf', 'isCnrxRegistry', 'isIntentOperation', 'isRegistryFactory',
      'readPreparedTransaction', 'registriesProblem', 'registryGuardiansOf', 'registryPackagesOf', 'verifyPreparedTransaction',
    ],
  },
  './canton/proto': {
    module: proto,
    names: ['TopologyRefusal', 'cantonHash', 'concat', 'damlValue', 'decodePreparedTransaction', 'decodeTopology', 'fromBase64', 'hashPreparedTransactionV2', 'int32', 'multiHashInput', 'participantId', 'transactionView', 'verifyPartyTopology'],
  },
};

/** The type-only exports of every entry: erased before runtime, so `Object.keys` cannot see them; the checker does. */
const TYPES: Record<string, string[]> = {
  '.': [
    'Bytes', 'DerivationScheme', 'DerivedCandidate', 'DerivedWalletKey', 'Ed25519KeyPair', 'Ed25519Signer', 'KekRole', 'KeyStore',
    'MnemonicErrorReport', 'MnemonicLanguage', 'PasskeySigningProvider', 'PersistedKeyPasswordWalletRecord', 'PersistedPasskeyWalletRecord',
    'PhraseMatch', 'ProviderFromMnemonicOptions', 'RegisterResult', 'RevealedWalletSecret', 'Signer', 'StoredRecord',
    'UnlockedKeyPasswordWallet', 'WalletPasswordProblem', 'WrappedSeed',
  ],
  './operations': [
    'HashSigner', 'IntentRoot', 'IntentSigningPolicy', 'OperationCatalogueEntry', 'OperationConfirm', 'OperationLeg', 'OperationSignature',
    'PreparedOperation', 'SignLegsOptions', 'WalletOperations', 'WalletRequest',
  ],
  './canton': [
    'CantonTransaction', 'CantonTransferFactory', 'CreateNode', 'DamlValue', 'ExerciseNode', 'FetchNode', 'IntentRoot', 'IntentSigningPolicy',
    'ReadPreparedTransaction', 'RegistryContract', 'RegistryGuardians', 'RegistryPackages', 'RollbackNode', 'TransactionNode',
  ],
  './canton/proto': ['PartyExpectation'],
  './web': ['StoredWalletAccount'],
};

/** The value exports of `./web`, pinned here too so the checker's list of every entry is held whole (its runtime check runs in the web project). */
const WEB_VALUES = ['clearPersistedWallet', 'deleteWalletAccount', 'evalPrf', 'getPersistedWallet', 'isWebAuthnSupported', 'listWalletAccounts', 'putPersistedWallet', 'putWalletAccount', 'registerPasskey'];

const ENTRY_SOURCES: Record<string, string> = { '.': 'index.ts', './operations': 'operations.ts', './canton': 'canton/index.ts', './canton/proto': 'canton/proto.ts', './web': 'web/index.ts' };

/** Every name an entry exports, values and types, as the TypeScript checker resolves its `export *` chains. */
function checkerExports(entry: string): string[] {
  const file = join(SRC, ENTRY_SOURCES[entry]!);
  const config = ts.getParsedCommandLineOfConfigFile(join(SRC, '..', 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  const program = ts.createProgram([file], config!.options);
  const checker = program.getTypeChecker();
  return checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)!)!).map((symbol) => symbol.name).sort();
}

/** `./operations` re-exports the intent policy of `./canton` for the signer; the two entries share these and nothing else. */
const OPERATIONS_FROM_CANTON = ['INTENT_OPERATIONS', 'IntentTransactionRefusedError', 'isIntentOperation', 'verifyPreparedTransaction'];

const SRC = __dirname;
const HEADLESS_ENTRIES = ['index.ts', 'operations.ts', 'canton/index.ts', 'canton/proto.ts'];

/** Every source file a module reaches through its relative imports and re-exports (type-only ones included). */
function reachable(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  for (const [, spec] of source.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = resolve(dirname(entry), spec!);
    const file = [`${base}.ts`, join(base, 'index.ts')].find((f) => {
      try {
        readFileSync(f);
        return true;
      } catch {
        return false;
      }
    });
    if (file) reachable(file, seen);
  }
  return seen;
}

describe('CAN-867: the public surface of @cancore/wallet', () => {
  test.each(Object.entries(SURFACE))('TC-CAN-867-01: %s exports exactly its pinned list, each a value that exists', (_entry, { module, names }) => {
    expect(Object.keys(module).sort()).toEqual([...names].sort());
    for (const name of names) expect(module[name]).toBeDefined();
  });

  test.each(Object.keys(ENTRY_SOURCES))('TC-CAN-867-02: %s exports exactly its pinned values and types, as the checker sees them', (entry) => {
    const values = entry === './web' ? WEB_VALUES : SURFACE[entry]!.names;
    expect(checkerExports(entry)).toEqual([...new Set([...values, ...TYPES[entry]!])].sort());
  });

  test('TC-CAN-867-07: the pinned entries are exactly the subpaths package.json exports', () => {
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
    expect(Object.keys(manifest.exports).sort()).toEqual(Object.keys(ENTRY_SOURCES).sort());
    expect([...Object.keys(SURFACE), './web'].sort()).toEqual(Object.keys(ENTRY_SOURCES).sort());
  });

  test('TC-CAN-867-03: the headless entries share only the intent policy, as the same objects', () => {
    const shared = (a: string[], b: string[]) => a.filter((n) => b.includes(n)).sort();
    const [rootNames, opNames, cantonNames, protoNames] = ['.', './operations', './canton', './canton/proto'].map((e) => SURFACE[e]!.names);
    expect(shared(opNames!, cantonNames!)).toEqual([...OPERATIONS_FROM_CANTON].sort());
    for (const name of OPERATIONS_FROM_CANTON) expect((operations as Record<string, unknown>)[name]).toBe((canton as Record<string, unknown>)[name]);
    expect(shared(rootNames!, [...opNames!, ...cantonNames!, ...protoNames!])).toEqual([]);
    expect(shared(opNames!, protoNames!)).toEqual([]);
    expect(shared(cantonNames!, protoNames!)).toEqual([]);
  });

  test.each(HEADLESS_ENTRIES)('TC-CAN-867-04: %s reaches no module of ./web and no browser global', (entry) => {
    const files = [...reachable(join(SRC, entry))].map((f) => relative(SRC, f));
    expect(files.filter((f) => f.startsWith('web/'))).toEqual([]);
    const browserGlobals = /\b(indexedDB|navigator\.credentials|window\.|document\.)/;
    expect(files.filter((f) => browserGlobals.test(readFileSync(join(SRC, f), 'utf8')))).toEqual([]);
  });
});
