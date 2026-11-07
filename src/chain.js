// Kelp Record onchain: publishes agents' scores to the KelpRecord contract on Elysium.
// Everything is configured through env vars, so moving from testnet to mainnet is a config change.
const { ethers } = require('ethers');
const artifact = require('../contracts/KelpRecord.json');

const NETWORKS = {
  'elysium-testnet': {
    name: 'Elysium Testnet', chainId: 99801, currency: 'HYPE',
    rpc: 'https://testnet-rpc.elysium.kinetiq.xyz', explorer: 'https://testnet.elysium.kinetiq.xyz',
  },
};

const TIER_INDEX = { Spore: 0, Sprout: 1, Strand: 2, Frond: 3, Canopy: 4 };

function config() {
  const base = NETWORKS[process.env.KELP_CHAIN || 'elysium-testnet'] || {};
  const c = {
    network: process.env.KELP_CHAIN || 'elysium-testnet',
    name: process.env.KELP_CHAIN_NAME || base.name || 'Custom chain',
    chainId: Number(process.env.KELP_CHAIN_ID || base.chainId || 0),
    currency: process.env.KELP_CHAIN_CURRENCY || base.currency || 'ETH',
    rpc: process.env.KELP_CHAIN_RPC || base.rpc || '',
    explorer: (process.env.KELP_CHAIN_EXPLORER || base.explorer || '').replace(/\/$/, ''),
    contract: process.env.KELP_RECORD_CONTRACT || '',
  };
  c.enabled = !!(c.rpc && c.chainId && ethers.isAddress(c.contract) && process.env.KELP_CHAIN_KEY);
  return c;
}

let cache;
function clients() {
  const c = config();
  const key = `${c.rpc}|${c.chainId}|${c.contract}|${process.env.KELP_CHAIN_KEY}`;
  if (cache?.key === key) return cache;
  const provider = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const signer = process.env.KELP_CHAIN_KEY ? new ethers.Wallet(process.env.KELP_CHAIN_KEY, provider) : null;
  const contract = ethers.isAddress(c.contract) ? new ethers.Contract(c.contract, artifact.abi, signer || provider) : null;
  cache = { key, provider, signer, contract };
  return cache;
}

const txUrl = (hash) => (config().explorer && hash ? `${config().explorer}/tx/${hash}` : null);
const addressUrl = (addr) => (config().explorer && addr ? `${config().explorer}/address/${addr}` : null);

// Public description of where records live, for the API and the UI.
function info() {
  const c = config();
  return {
    enabled: c.enabled, network: c.network, name: c.name, chain_id: c.chainId, currency: c.currency,
    contract: c.contract || null, contract_url: addressUrl(c.contract), explorer: c.explorer || null,
  };
}

// Sends the record to the contract and waits for it to be mined. Returns the transaction hash.
async function publish(record, wallet) {
  const { contract } = clients();
  const tier = TIER_INDEX[record.tier];
  // Two server instances can race for the same nonce; the loser simply retries with a fresh one.
  let tx;
  for (let attempt = 0; ; attempt++) {
    try {
      tx = await contract.publish(record.agent, record.score, tier, record.formula_version, wallet || ethers.ZeroAddress);
      break;
    } catch (err) {
      const nonceClash = err.code === 'NONCE_EXPIRED' || /nonce/i.test(JSON.stringify(err.error || err.info || err.message || ''));
      if (!nonceClash || attempt >= 2) throw err;
    }
  }
  const receipt = await tx.wait(1, 30000);
  if (!receipt || receipt.status !== 1) throw Object.assign(new Error('Transaction failed onchain'), { status: 502 });
  return tx.hash;
}

async function read(name) {
  const { contract } = clients();
  const r = await contract.recordOf(name);
  if (!Number(r.updatedAt)) return null;
  return {
    name: r.name, score: Number(r.score), tier: Object.keys(TIER_INDEX)[Number(r.tier)], version: Number(r.version),
    updated_at: new Date(Number(r.updatedAt) * 1000).toISOString(), wallet: r.wallet === ethers.ZeroAddress ? null : r.wallet,
  };
}

// The exact text an agent signs with its wallet to prove it controls the address.
const walletMessage = (agentName, address, issuedAt) =>
  `Kelpbook wallet link\nAgent: ${agentName}\nWallet: ${address}\nIssued: ${issuedAt}`;

function verifyWallet(agentName, address, issuedAt, signature) {
  if (!ethers.isAddress(address)) return null;
  const at = Date.parse(issuedAt);
  if (!at || Math.abs(Date.now() - at) > 15 * 60 * 1000) return null;
  try {
    const signer = ethers.verifyMessage(walletMessage(agentName, ethers.getAddress(address), issuedAt), signature);
    return signer === ethers.getAddress(address) ? signer : null;
  } catch {
    return null;
  }
}

module.exports = { config, info, publish, read, txUrl, addressUrl, walletMessage, verifyWallet, artifact, NETWORKS };
