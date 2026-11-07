// Deploys KelpRecord with the KELP_CHAIN_KEY wallet as owner and writer.
//   KELP_CHAIN_KEY=0x... node scripts/deploy-record.js            (Elysium testnet)
//   KELP_CHAIN=elysium KELP_CHAIN_RPC=... KELP_CHAIN_ID=... ...     (any other network)
const { ethers } = require('ethers');
const chain = require('../src/chain');

(async () => {
  const c = chain.config();
  if (!process.env.KELP_CHAIN_KEY) throw new Error('Set KELP_CHAIN_KEY to the deployer private key');
  if (!c.rpc || !c.chainId) throw new Error('Set KELP_CHAIN_RPC and KELP_CHAIN_ID for this network');
  const provider = new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(process.env.KELP_CHAIN_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log(`network  ${c.name} (chain ${c.chainId})`);
  console.log(`deployer ${wallet.address}  balance ${ethers.formatEther(balance)} ${c.currency}`);
  if (balance === 0n) throw new Error(`The deployer has no ${c.currency} for gas`);
  const factory = new ethers.ContractFactory(chain.artifact.abi, chain.artifact.bytecode, wallet);
  const contract = await factory.deploy(wallet.address);
  console.log(`tx       ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`contract ${address}`);
  if (c.explorer) console.log(`explorer ${c.explorer}/address/${address}`);
  console.log(`\nSet KELP_RECORD_CONTRACT=${address} on the server.`);
})().catch((err) => { console.error(err.shortMessage || err.message); process.exit(1); });
