import { encodeCantonAmount, encodeCantonDestination, encodeCantonOutputAsset, encodeCantonRecipient } from './cantonDestination';

// Independent cross-check of the Canton-destination encoder (CAN-1935 acceptance: "the vector matches
// the attestor's and Daml's encoding"). The expected values below were NOT produced by this package:
// they were computed once by running the attestor's own implementation (cantonDestination,
// instrumentAsset, partyRecipient, decimalUnits) unmodified, and are pinned here as literals.
//   source: Cancore-io/attestor src/canton.ts, last changed in commit 7980a4a4e761db79d30124e6cd10165efd3d568b
//   (repo main was 8937fdf5938786a32bfe1c5fdd3a6f6903c48bb8 at the time)
// If the attestor changes these formulas, this test must go red here before it goes red in production.

const DESTINATIONS = {
  "mainnet": "0x8d6e3eea79c707a9549bdb1206260cd46ef29e86763e19a8a3f494bc6b499440",
  "testnet": "0xe9988c091217763216d67a428bebd45f2f157fcf531ae52fba942fb9c0658682",
  "devnet": "0x0f6f82ab16aa8bfd8099433fefad277a2ac9da342a11fe80fbfc3342c5bb0db9"
} as const;

const INSTRUMENTS = [
  {
    "admin": "DSO::1220abababababababababababababababababababababababababababababababab",
    "id": "Amulet",
    "outputAsset": "0xb51a9d6fc72b75fd7ff06972f52963a372b3a0667b19b7c98ddc661a5db4887c"
  },
  {
    "admin": "USDCx-admin::1220abababababababababababababababababababababababababababababababab",
    "id": "USDCx",
    "outputAsset": "0xf03d24c97da99df09292f672e51d8ce904c77d38162a112c15549527f487ad82"
  },
  {
    "admin": "a",
    "id": "b",
    "outputAsset": "0x9db0257947cfcb1921813ceec0e7ecc745eb4128807de2a8500c540474662f92"
  },
  {
    "admin": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "id": "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
    "outputAsset": "0xec019853cf7793b390b1efdd06886cd22e2bdc11db966e9b5f813c1a22f70007"
  },
  {
    "admin": "adm::1220abababababababababababababababababababababababababababababababab",
    "id": "Токен-ü",
    "outputAsset": "0x058047ff8cf854698e3939bd7836f72d6c8147455f5efa92df76be20caebe2bb"
  }
];

const PARTIES = [
  {
    "party": "alice::1220abababababababababababababababababababababababababababababababab",
    "recipient": "0xb93c7696fcc6a652ca709766ce580a8f0277ba67422d61e0ba2b1f7e36296fee"
  },
  {
    "party": "PAR::TY::1220abababababababababababababababababababababababababababababababab",
    "recipient": "0x5c0662c7a9003aab10c39cddf40ed5e2d421189d954d97eddeb5ac34a74a5a46"
  },
  {
    "party": "p",
    "recipient": "0x2304e88f144ae9318c71b0fb9e0f44bd9e0c6c58fb1b5315a35fd8b4b2a444ab"
  },
  {
    "party": "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "recipient": "0x896cad97c7812007486b67911a77412a96b04b54e01e151dbcfb35d316983c2a"
  },
  {
    "party": "Алиса::1220abababababababababababababababababababababababababababababababab",
    "recipient": "0x91b08de1a7aef6eecdbdd886d8f10be1437ed1a6eca65f82cd479778d4419076"
  }
];

// Daml Numeric 10: 0 and 10 fractional digits, leading zeros, and a 128-bit maximum.
const AMOUNTS = [
  {
    "amount": "0",
    "units": "0"
  },
  {
    "amount": "0.0",
    "units": "0"
  },
  {
    "amount": "1",
    "units": "10000000000"
  },
  {
    "amount": "1.5",
    "units": "15000000000"
  },
  {
    "amount": "0.0000000001",
    "units": "1"
  },
  {
    "amount": "1.0000000001",
    "units": "10000000001"
  },
  {
    "amount": "12345.1234567890",
    "units": "123451234567890"
  },
  {
    "amount": "99999999999999999999.9999999999",
    "units": "999999999999999999999999999999"
  },
  {
    "amount": "340282366920938463463374607431768211455",
    "units": "3402823669209384634633746074317682114550000000000"
  },
  {
    "amount": "007.50",
    "units": "75000000000"
  }
];

// Refused by the attestor's decimalUnits (it throws); this encoder must refuse them as well.
const REFUSED = [
  "1.00000000001",
  "-1",
  "1e3",
  "",
  "1,5",
  " 1",
  "1.",
  ".5",
  "0x10"
];

describe("encoder equals the attestor's implementation (pinned outputs)", () => {
  test.each(Object.entries(DESTINATIONS))('destination of canton:%s', (network, expected) => {
    expect(encodeCantonDestination(network as keyof typeof DESTINATIONS)).toBe(expected);
  });

  test.each(INSTRUMENTS)('outputAsset of $admin / $id', ({ admin, id, outputAsset }) => {
    expect(encodeCantonOutputAsset({ admin, id })).toBe(outputAsset);
  });

  test.each(PARTIES)('recipient of party $party', ({ party, recipient }) => {
    expect(encodeCantonRecipient(party)).toBe(recipient);
  });

  test.each(AMOUNTS)('amountDelivered of $amount', ({ amount, units }) => {
    expect(encodeCantonAmount(amount)).toBe(BigInt(units));
  });

  test.each(REFUSED)('refuses %j like the attestor', (bad) => {
    expect(() => encodeCantonAmount(bad)).toThrow();
  });
});
