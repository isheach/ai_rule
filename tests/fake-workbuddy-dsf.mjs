import { createInterface } from 'node:readline';

// This is a fixture-only schema. Production Sol calls the locally installed
// WorkBuddy tools using their own schema and authorization profile.
const model = 'deepseek-v4-flash';
const tools = [
  { name: 'get_task_bridge_status', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'run_workbuddy_task',
    inputSchema: {
      type: 'object', required: ['task', 'directory', 'profile'],
      properties: {
        task: { type: 'string' }, directory: { type: 'string' },
        profile: { type: 'string', enum: ['fixture-read-only'] }, resumeSession: { type: 'string' }
      }
    }
  }
];
let runs = 0;
const sessions = new Set();

function call({ name, arguments: args = {} }) {
  if (name === 'get_task_bridge_status') return { ready: true, model, runs, profile: 'fixture-read-only' };
  if (name !== 'run_workbuddy_task') throw Error('Unknown fixture tool.');
  if (!args.task || !args.directory || args.profile !== 'fixture-read-only'
    || (args.resumeSession && !sessions.has(args.resumeSession))) throw Error('Invalid fixture arguments.');
  runs++;
  const session_id = args.resumeSession ?? 'fixture-session-' + runs;
  sessions.add(session_id);
  return { model, status: 'completed', task_id: 'fixture-task-' + runs, session_id, answer: 'fixture result: ' + args.task };
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === 'initialize') {
    result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deepseek-v4-flash-workbuddy', version: 'fixture' } };
  } else if (method === 'tools/list') {
    result = { tools };
  } else if (method === 'tools/call') {
    try { result = { content: [{ type: 'text', text: JSON.stringify(call(params)) }], isError: false }; }
    catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
  } else throw Error('Unsupported fixture method.');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
