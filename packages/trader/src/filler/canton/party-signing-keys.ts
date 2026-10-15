import { PartyToParticipant, SigningPublicKey } from '@canton-network/core-ledger-proto';
import { MessageType, RepeatType, ScalarType } from '@protobuf-ts/runtime';

interface SigningKeys {
  keys: SigningPublicKey[];
  threshold: number;
}

// core-ledger-proto 1.13 omits PTP field 6; use Canton's schema until its generated package catches up.
// https://github.com/digital-asset/canton/blob/fad99cfe87ab5a4d400f2a0d45f1d4a31097e3d7/community/base/src/main/protobuf/com/digitalasset/canton/protocol/v30/topology.proto
const keys = new MessageType<SigningKeys>('com.digitalasset.canton.crypto.v30.SigningKeysWithThreshold', [
  { no: 1, name: 'keys', kind: 'message', repeat: RepeatType.UNPACKED, T: () => SigningPublicKey },
  { no: 2, name: 'threshold', kind: 'scalar', T: ScalarType.UINT32 },
]);
const hosting = new MessageType<PartyToParticipant & { partySigningKeys?: SigningKeys }>(PartyToParticipant.typeName, [
  ...PartyToParticipant.fields,
  { no: 6, name: 'party_signing_keys', kind: 'message', T: () => keys },
]);

/** Decode every hosting field; unsupported fields are refused rather than silently signed. */
export function partySigningKeys(mapping: PartyToParticipant): SigningKeys | undefined {
  return hosting.fromBinary(PartyToParticipant.toBinary(mapping), { readUnknownField: 'throw' }).partySigningKeys;
}
