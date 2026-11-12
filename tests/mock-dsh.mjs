import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('mock-dsh-0.3'); process.exit(0); }
if (args.includes('--help')) { console.log('--json --permission-mode --approval-policy'); process.exit(0); }
if (args.includes('--dump-config')) {
  console.log("- id: agent-default-model\n  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n    reasoningEffort: max"); process.exit(0);
}
const sessionArg = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : undefined;
const sessionId = sessionArg || `session-mock-${process.pid}-${Math.random().toString(16).slice(2)}`;
const prompt = fs.readFileSync(0, 'utf8');
const emit = value => console.log(JSON.stringify(value));
emit({ type: 'session', sessionId, cwd: process.cwd() });
const sleep = prompt.match(/(?:^|\n\n)sleep:(\d+)$/)?.[1];
if (prompt === 'hang' || prompt.endsWith('\n\nhang')) { setInterval(() => {}, 1000); }
else if (prompt === 'nofinal') { process.exit(0); }
else if (sleep) {
  setTimeout(() => {
    emit({ type: 'tool_call', tool: 'read', input: { text: 'MOCK-TOOL-INPUT-MUST-NOT-BE-LOGGED' } });
    emit({ type: 'final', sessionId, reason: { kind: 'completed' }, text: 'mock final: slept ' + sleep });
  }, Number(sleep));
}
else {
  emit({ type: 'thinking', text: 'MOCK-REASONING-MUST-NOT-BE-LOGGED' });
  emit({ type: 'tool_call', tool: 'read', input: { text: 'MOCK-TOOL-INPUT-MUST-NOT-BE-LOGGED' } });
  emit({ type: 'tool_result', status: 'completed', result: 'MOCK-TOOL-RESULT-MUST-NOT-BE-LOGGED' });
  emit({ type: 'final', sessionId, reason: { kind: prompt === 'fail' ? 'error' : 'completed' }, text: 'mock final: ' + prompt });
}
