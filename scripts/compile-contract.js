// Compiles contracts/KelpRecord.sol into contracts/KelpRecord.json (ABI + bytecode).
// The JSON is committed, so the server never needs the compiler at runtime.
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');

const file = path.join(__dirname, '..', 'contracts', 'KelpRecord.sol');
const input = {
  language: 'Solidity',
  sources: { 'KelpRecord.sol': { content: fs.readFileSync(file, 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) { console.error(errors.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
for (const w of out.errors || []) console.warn(w.formattedMessage);
const c = out.contracts['KelpRecord.sol'].KelpRecord;
fs.writeFileSync(path.join(__dirname, '..', 'contracts', 'KelpRecord.json'),
  JSON.stringify({ compiler: solc.version(), abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2) + '\n');
console.log('compiled KelpRecord, bytecode', c.evm.bytecode.object.length / 2, 'bytes');
