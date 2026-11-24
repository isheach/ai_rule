import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const expected = process.env.AGY_FIXTURE_AUTH;
const settings = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
assert.equal(settings.toolPermission, 'strict');
assert.equal(settings.allowNonWorkspaceAccess, false);
assert.equal(process.env.OPENAI_API_KEY, undefined);
if (expected === 'enterprise') {
  assert.equal(process.env.AGY_ADC_AUTH, 'true');
  assert.ok(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  assert.equal(settings.modelProvider, undefined);
} else {
  assert.equal(settings.modelProvider, 'gemini');
  assert.equal(process.env.GEMINI_API_KEY, 'offline-fixture-google-key');
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
}

if (args[0] === '--version') {
  console.log('agy version 1.5.16');
} else if (args[0] === 'models') {
  console.log('fixture-draft    Fixture Draft\nfixture-research    Fixture Research');
} else {
  const value = name => args[args.indexOf(name) + 1];
  assert.equal(value('--agent'), 'ai-rule-text');
  assert.equal(value('--mode'), 'default');
  assert.equal(value('--input-format'), 'stream-json');
  assert.equal(value('--output-format'), 'stream-json');
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  const agent = fs.readFileSync(path.join('.agents', 'agents', 'ai-rule-text', 'agent.md'), 'utf8');
  assert.match(agent, /^tools: \[\]$/m);
  const conversationId = '9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f';
  const behavior = process.env.AGY_FIXTURE_BEHAVIOR;
  const emit = event => console.log(JSON.stringify(event));
  const model = value('--model');
  emit({ event: 'init', conversation_id: conversationId, init: {
    cwd: process.cwd(), tools: behavior === 'unsafe' ? ['send_message'] : [], permission_mode: 'strict', agent: 'ai-rule-text',
    model: behavior === 'wrong-model' ? 'different-model' : model
  } });
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const parsed = JSON.parse(input);
  assert.equal(parsed.event, 'user');
  assert.equal(typeof parsed.message.content, 'string');
  fs.appendFileSync(process.env.AGY_FIXTURE_EVENTS, JSON.stringify({ model, effort: args.includes('--effort') ? value('--effort') : null,
    prompt: parsed.message.content }) + '\n');
  emit({ event: 'step_update', step_update: { conversation_id: conversationId, state: 'DONE',
    step_type: behavior === 'tool' ? 'tool' : 'agent_response' } });
  emit({ event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS',
    response: `Draft from ${model}.`, usage: { total_tokens: 48 },
    ...(behavior === 'partial' ? { finished_reason: 'print_timeout' } : {}) } });
}
