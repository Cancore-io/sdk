/**
 * The anvil stand of this repository's CI (operator decision Ыу-1, CAN-1846):
 * an anvil without a fork, the contracts of `artifacts.json` deployed and
 * configured as meta's `make intent-genesis` does, and one intent driven
 * open → fill → settle as `make intent-smoke` does. It writes what the
 * integration suites read (`npm run test:int`):
 *
 *   <out>/intent.json        CANCORE_INTENT_JSON — router, attestors, destinations
 *   <out>/evm.json           the test tokens (read next to intent.json)
 *   <out>/local-actors.env   CANCORE_ACTORS_ENV — <ROLE>_EVM_PRIVATE_KEY / _EVM_ADDRESS
 *
 *   anvil --chain-id 11155111 &
 *   npm run build -w @cancore/contracts
 *   node packages/trader/test/stand/up.mjs <out> [rpc url, default http://127.0.0.1:8545]
 *
 * Every key is derived from anvil's public test mnemonic: test values only.
 * The stand also serves the hermetic profile of the filler node's CI (CAN-1950).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, HDNodeWallet, Interface, JsonRpcProvider, Mnemonic, NonceManager, hexlify, randomBytes, zeroPadValue, toBeHex } from 'ethers';
import {
  CANTON_ORIGIN_ID,
  CANTON_SOURCE_ANCHOR,
  FILL_PROOF_TYPES,
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  PERMIT2_ADDRESS,
  PERMIT_WITNESS_TYPES,
  QUOTE_TYPES,
  encodeCantonDestination,
  fillerIdHash,
  routerDomain,
} from '@cancore/contracts';

const out = process.argv[2];
const rpcUrl = process.argv[3] ?? 'http://127.0.0.1:8545';
if (!out) throw new Error('usage: up.mjs <out dir> [rpc url]');

const artifacts = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'artifacts.json'), 'utf8'));
const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, pollingInterval: 100 });
const chainId = Number((await provider.getNetwork()).chainId);

// Roles from index 20 of the test mnemonic: the first ten anvil accounts stay free for suites that sign with them
// and must NOT be a stand ticket signer (escrow.int.test.ts, ticket.int.test.ts).
const ROLES = ['DEPLOYER', 'ALICE', 'BOB', 'FRANK', 'FILLER1', 'RELAYER', 'QUOTESIGNER', 'TICKETSIGNER', 'ATTESTOR1', 'ATTESTOR2', 'ATTESTOR3'];
const mnemonic = Mnemonic.fromPhrase('test test test test test test test test test test test junk');
const keys = Object.fromEntries(ROLES.map((role, i) => [role, HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${20 + i}`)]));
for (const w of Object.values(keys)) await provider.send('anvil_setBalance', [w.address, toBeHex(10n ** 22n)]);
// One NonceManager per role: a fresh one per call would re-read a nonce the provider may still have cached.
const signers = Object.fromEntries(ROLES.map((role) => [role, new NonceManager(keys[role].connect(provider))]));
const signer = (role) => signers[role];
const deployer = signer('DEPLOYER');

// Permit2 at its canonical address: MockPermit2's runtime code builds its domain from block.chainid and address(this).
await provider.send('anvil_setCode', [PERMIT2_ADDRESS, artifacts.MockPermit2.deployedBytecode]);

const deploy = async (name, ...args) => {
  const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, deployer).deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  return { contract, address: (await contract.getAddress()).toLowerCase(), block: receipt.blockNumber };
};
const USDC = await deploy('TestToken', 'USD Coin (stand)', 'USDC');
const BTC = await deploy('TestToken', 'Bitcoin (stand)', 'BTC');

const attestors = ['ATTESTOR1', 'ATTESTOR2', 'ATTESTOR3'].map((r) => keys[r].address).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
const threshold = 2;
const feeRecipient = keys.DEPLOYER.address;
const deployed = await deploy('CancoreRouter', PERMIT2_ADDRESS, feeRecipient, attestors, threshold, 1);
const router = deployed.contract;
const routerAddress = deployed.address;

// Configuration, as meta's deployIntentLocal.ts.
const PROOF_WINDOW = 15 * 60;
const MIN_INPUT = 10n ** 12n;
const evmDestination = zeroPadValue(toBeHex(chainId), 32);
const cantonDestination = encodeCantonDestination('devnet');
const send = async (tx) => (await tx).wait();
await send(router.setProofWindow(evmDestination, PROOF_WINDOW, true));
await send(router.setProofWindow(cantonDestination, PROOF_WINDOW, false));
for (const t of [USDC, BTC]) await send(router.setMinInput(t.address, MIN_INPUT));
await send(router.addQuoteSigner(keys.QUOTESIGNER.address));
await send(router.addTicketSigner(keys.TICKETSIGNER.address));
await send(router.setSourceRouter(CANTON_ORIGIN_ID.devnet, CANTON_SOURCE_ANCHOR));
// One EVM network: an EVM → EVM intent opens and fills on this router, which must be its own registered source.
await send(router.setSourceRouter(chainId, routerAddress));

// One intent open → fill → settle, as meta's intentSmokeLocal.ts: the suites read its logs and its settled escrow.
const as = (role, c) => c.connect(signer(role));
const token = (t) => new Contract(t.address, artifacts.TestToken.abi, provider);
const now = BigInt((await provider.getBlock('latest')).timestamp);
const inputAmount = 100n * 10n ** 18n;
const minReceived = 95n * 10n ** 18n;
const fillerId = fillerIdHash('filler1');
const order = {
  user: keys.ALICE.address,
  originChainId: BigInt(chainId),
  inputToken: USDC.address,
  inputAmount,
  destination: evmDestination,
  outputAsset: zeroPadValue(BTC.address, 32),
  minReceived,
  recipient: zeroPadValue(keys.BOB.address, 32),
  createdAt: now,
  fillDeadline: now + 1800n,
  feeBps: 30n,
  fillerId,
};
const orderHash = await router.hashOrder(order);
const domain = routerDomain(chainId, routerAddress);

await send(as('ALICE', token(USDC)).mint(inputAmount));
await send(as('ALICE', token(USDC)).approve(PERMIT2_ADDRESS, inputAmount));
const permit = { permitted: { token: order.inputToken, amount: inputAmount }, nonce: BigInt(hexlify(randomBytes(31))), deadline: order.fillDeadline };
const permitSig = await keys.ALICE.signTypedData({ name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS }, PERMIT_WITNESS_TYPES, { ...permit, spender: routerAddress, witness: order });
const quoteDeadline = now + 300n;
const quoteSig = await keys.QUOTESIGNER.signTypedData(domain, QUOTE_TYPES, { orderHash, quoteDeadline });
await send(as('RELAYER', router).openFor(order, permit, permitSig, quoteDeadline, quoteSig));

const ticket = {
  orderHash,
  fillerId,
  deliveryKey: keys.FILLER1.address,
  repayTo: zeroPadValue(keys.FILLER1.address, 32),
  attempt: 1,
  validFrom: now,
  validUntil: order.fillDeadline - 1n,
};
const ticketSig = await keys.TICKETSIGNER.signTypedData(FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, ticket);
await send(as('FILLER1', token(BTC)).mint(minReceived));
await send(as('FILLER1', token(BTC)).approve(routerAddress, minReceived));
const fillReceipt = await send(as('FILLER1', router).fill(order, minReceived, ticket, ticketSig));
const routerInterface = new Interface(artifacts.CancoreRouter.abi);
const filled = fillReceipt.logs.map((l) => { try { return routerInterface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'Filled');
if (!filled) throw new Error('fill emitted no Filled');

const proof = {
  kind: 1,
  orderHash,
  destination: order.destination,
  fillRef: fillReceipt.hash,
  recipient: order.recipient,
  outputAsset: order.outputAsset,
  amountDelivered: filled.args.received,
  filledAt: filled.args.filledAt,
  fillerId: filled.args.fillerId,
  repayTo: filled.args.repayTo,
  attempt: 1,
  setId: await router.attestationSetFor(orderHash),
};
const sigs = await Promise.all(
  ['ATTESTOR1', 'ATTESTOR2', 'ATTESTOR3']
    .map((r) => keys[r])
    .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
    .slice(0, threshold)
    .map((w) => w.signTypedData(domain, FILL_PROOF_TYPES, proof)),
);
await send(as('RELAYER', router).settle(order, proof, sigs));
const status = (await router.intents(orderHash)).status;
if (status !== 2n) throw new Error(`the smoke intent ended in status ${status}, not Settled`);

mkdirSync(out, { recursive: true });
const intent = {
  chainId,
  rpcUrlHost: rpcUrl,
  contracts: { CancoreRouter: routerAddress, Permit2: PERMIT2_ADDRESS },
  deployBlock: deployed.block,
  bytecodeHash: artifacts.CancoreRouter.bytecodeHash,
  source: artifacts.source,
  feeRecipient,
  attestors,
  threshold,
  quoteSigner: keys.QUOTESIGNER.address,
  ticketSigner: keys.TICKETSIGNER.address,
  destinations: {
    [`evm:${chainId}`]: { destination: evmDestination, proofWindow: PROOF_WINDOW, isEvm: true },
    [`canton:${CANTON_ORIGIN_ID.devnet}`]: { destination: cantonDestination, proofWindow: PROOF_WINDOW, isEvm: false },
  },
  sourceRouters: { [chainId]: routerAddress, [CANTON_ORIGIN_ID.devnet.toString()]: CANTON_SOURCE_ANCHOR },
  minInput: MIN_INPUT.toString(),
  smoke: { orderHash, fill: fillReceipt.hash },
};
writeFileSync(join(out, 'intent.json'), `${JSON.stringify(intent, null, 2)}\n`);
writeFileSync(join(out, 'evm.json'), `${JSON.stringify({ chainId, tokens: { USDC: { address: USDC.address }, BTC: { address: BTC.address } } }, null, 2)}\n`);
writeFileSync(
  join(out, 'local-actors.env'),
  `${ROLES.flatMap((r) => [`${r}_EVM_PRIVATE_KEY=${keys[r].privateKey}`, `${r}_EVM_ADDRESS=${keys[r].address}`]).join('\n')}\n`,
);
console.log(`stand up: CancoreRouter ${routerAddress} (evm-contracts@${artifacts.source.commit.slice(0, 7)}), smoke intent ${orderHash} settled`);
