// Recording stdio MCP fixture. All file writes stay inside the supplied scratch root.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.env.BARRY_QA_ROOT;
if (!root || !fs.existsSync(path.join(root, '.barry-adapter-qa'))) throw new Error('QA scratch marker missing');
const tools = [
  { name: 'echo', description: 'Echo a marker and the Barry session context', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } },
  { name: 'write', description: 'Write a marker to the controlled QA scratch file', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } },
  { name: 'error', description: 'Return a deliberate tool error', inputSchema: { type: 'object', properties: {} } },
  { name: 'wait', description: 'Wait briefly to exercise interruption', inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0, maximum: 10000 } } } },
];
async function dispatch(message) {
  if (message.id === undefined) return;
  let result;
  switch (message.method) {
    case 'initialize': result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'barry-parity-probe', version: '1' } }; break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools }; break;
    case 'tools/call': {
      const { name, arguments: args = {} } = message.params;
      if (!tools.some(tool => tool.name === name)) throw new Error('Unknown probe tool');
      const record = { sessionId: process.env.BARRY_SESSION_ID, tool: name, args, at: new Date().toISOString() };
      fs.appendFileSync(path.join(root, 'ledger.jsonl'), JSON.stringify(record) + '\n');
      if (name === 'write') fs.writeFileSync(path.join(root, 'barry-write.txt'), String(args.marker));
      if (name === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(10000, Math.max(0, Number(args.ms) || 0))));
      result = { content: [{ type: 'text', text: JSON.stringify(record) }], ...(name === 'error' ? { isError: true } : {}) }; break;
    }
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { process.exitCode = 1; return; }
  void dispatch(message).catch(error => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }) + '\n'));
});
