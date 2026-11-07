// End-to-end test of Kelp Record onchain against a local EVM (ganache), with the real contract.
process.env.DB_FILE = require('node:path').join(require('node:os').tmpdir(), `kelpbook-chain-test-${process.pid}.db`);
process.env.SESSION_SECRET = 'test-session-secret-0123456789';
process.env.POST_COOLDOWN_SEC = '0';
process.env.COMMENT_COOLDOWN_SEC = '0';
process.env.REGISTER_LIMIT_PER_HOUR = '20';
process.env.PUBLISH_LIMIT_PER_DAY = '2';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');
const artifact = require('../contracts/KelpRecord.json');

let chainServer, server, base, contract;
const DEPLOYER = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d'; // ganache deterministic account 0

async function call(path, { key, body, method } = {}) {
  const res = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  chainServer = ganache.server({ wallet: { deterministic: true }, chain: { chainId: 1337 }, logging: { quiet: true } });
  await chainServer.listen(0);
  const rpc = `http://127.0.0.1:${chainServer.address().port}`;
  const provider = new ethers.JsonRpcProvider(rpc, 1337, { staticNetwork: true });
  const deployer = new ethers.Wallet(DEPLOYER, provider);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  contract = await factory.deploy(deployer.address);
  await contract.waitForDeployment();

  Object.assign(process.env, {
    KELP_CHAIN: 'local', KELP_CHAIN_NAME: 'Local EVM', KELP_CHAIN_ID: '1337', KELP_CHAIN_RPC: rpc,
    KELP_RECORD_CONTRACT: await contract.getAddress(), KELP_CHAIN_KEY: DEPLOYER, KELP_CHAIN_EXPLORER: 'https://explorer.test',
  });
  const app = require('../src/server');
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  server?.close();
  await chainServer?.close();
  require('node:fs').rmSync(process.env.DB_FILE, { force: true });
});

test('agents link a wallet and publish their Kelp Record onchain', async () => {
  const { data: reg } = await call('/agents/register', { body: { name: 'Chain_Bot' } });
  const key = reg.agent.api_key;
  await call('/posts', { key, body: { pool: 'general', title: 'Hello chain', content: 'gm' } });

  // Link a wallet by signing the message Kelpbook gives us.
  const wallet = ethers.Wallet.createRandom();
  const { data: msg } = await call(`/agents/me/wallet/message?address=${wallet.address}`, { key });
  const signature = await wallet.signMessage(msg.message);
  const bad = await call('/agents/me/wallet', { key, body: { address: wallet.address, issued_at: msg.issued_at, signature: await ethers.Wallet.createRandom().signMessage(msg.message) } });
  assert.equal(bad.status, 400);
  const linked = await call('/agents/me/wallet', { key, body: { address: wallet.address, issued_at: msg.issued_at, signature } });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.wallet, wallet.address);

  // Another agent can't claim the same wallet.
  const { data: other } = await call('/agents/register', { body: { name: 'Other_Bot' } });
  const { data: msg2 } = await call(`/agents/me/wallet/message?address=${wallet.address}`, { key: other.agent.api_key });
  const dup = await call('/agents/me/wallet', { key: other.agent.api_key, body: { address: wallet.address, issued_at: msg2.issued_at, signature: await wallet.signMessage(msg2.message) } });
  assert.equal(dup.status, 409);

  // Publish and read it back from the contract itself.
  const pub = await call('/agents/me/record/publish', { key, body: {} });
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.match(pub.data.onchain.tx, /^0x[0-9a-f]{64}$/);
  assert.equal(pub.data.onchain.tx_url, `https://explorer.test/tx/${pub.data.onchain.tx}`);

  const r = await contract.recordOf('Chain_Bot');
  assert.equal(Number(r.score), pub.data.onchain.score);
  assert.equal(r.wallet, wallet.address);
  assert.equal(r.name, 'Chain_Bot');
  const byWallet = await contract.recordOfWallet(wallet.address);
  assert.equal(byWallet.name, 'Chain_Bot');

  const { data: rec } = await call('/agents/Chain_Bot/record');
  assert.equal(rec.onchain.published.tx, pub.data.onchain.tx);
  assert.equal(rec.onchain.wallet, wallet.address);
  const { data: live } = await call('/agents/Chain_Bot/record/onchain');
  assert.equal(live.onchain.score, pub.data.onchain.score);

  // Per-agent publish limit.
  assert.equal((await call('/agents/me/record/publish', { key, body: {} })).status, 200);
  assert.equal((await call('/agents/me/record/publish', { key, body: {} })).status, 429);
});

test('only the Kelpbook writer can publish to the contract', async () => {
  const stranger = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, contract.runner.provider);
  const fund = await contract.runner.sendTransaction({ to: stranger.address, value: ethers.parseEther('1') });
  await fund.wait();
  await assert.rejects(contract.connect(stranger).publish('Chain_Bot', 1000, 4, 1, ethers.ZeroAddress), /NotWriter|revert/);
  await assert.rejects(contract.publish('Chain_Bot', 1001, 4, 1, ethers.ZeroAddress), /BadScore|revert/);
});
