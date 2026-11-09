import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('mock-dsh-0.2'); process.exit(0); }
if (args.includes('--help')) { console.log('--json --permission-mode --approval-policy'); process.exit(0); }
if (args.includes('--dump-config')) {
  console.log("- id: agent-default-model\n  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n    reasoningEffort: max"); process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
const emit = value => console.log(JSON.stringify(value));
emit({ type: 'session', sessionId: 'session-mock', cwd: process.cwd() });
if (prompt === 'hang') { setInterval(() => {}, 1000); }
else if (prompt === 'nofinal') { process.exit(0); }
else {
  emit({ type: 'thinking', text: 'MOCK-REASONING-MUST-NOT-BE-LOGGED' });
  emit({ type: 'tool_call', tool: 'read', input: { text: 'MOCK-TOOL-INPUT-MUST-NOT-BE-LOGGED' } });
  emit({ type: 'tool_result', status: 'completed', result: 'MOCK-TOOL-RESULT-MUST-NOT-BE-LOGGED' });
  emit({ type: 'final', sessionId: 'session-mock', reason: { kind: prompt === 'fail' ? 'error' : 'completed' }, text: 'mock final: ' + prompt });
}
