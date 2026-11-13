import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadManifest, sha256File } from '../bridges/hy4/manifest.mjs';
import { Hy4AcpManager, canonicalWithin } from '../bridges/hy4/acp.mjs';
import { RoutingCoordinator, PreAdmissionRejection, AdmissionCode } from '../bridges/dsh/routing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = path.join(root, 'tests', 'fake-codebuddy-acp.mjs');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rule-hy4-'));
const task = (workspace, prompt = 'fixture prompt', key = 'hy4-1') => ({
  prompt, cwd: workspace, idempotencyKey: key, timeoutMs: 3000, permissionMode: 'read-only'
});
const textTask = (workspace, prompt, key) => ({ ...task(workspace, prompt, key), capability: 'text-only' });

function fixture(mode = 'normal', options = {}) {
  const dir = temp(), config = path.join(dir, 'config'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(config); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(config, 'mode.txt'), mode);
  const file = path.join(dir, 'manifest.json');
  const value = {
    schema: 1, node_path: process.execPath, cli_entry: fake, config_dir: config,
    workspace_root: workspace, expected_version: '2.184.0',
    expected_entry_sha256: sha256File(fake), internet_environment: 'internal', ...options
  };
  fs.writeFileSync(file, JSON.stringify(value));
  return { file, workspace, config, value };
}
const managerFor = (mode = 'normal', options = {}) => {
  const f = fixture(mode, options);
  return { manager: new Hy4AcpManager({ manifest: loadManifest(f.file), runtime: temp() }), ...f };
};
const auth = Object.freeze({ schema: 1, enabled: true, authorization_ref: 'test-approval', scope: 'pre_admission_only', max_attempts: 1 });

test('manifest is local and rejects env/credential-shaped overrides', () => {
  const f = fixture();
  assert.equal(loadManifest(f.file).workspace_root, fs.realpathSync(f.workspace));
  const bad = temp(), file = path.join(bad, 'm.json');
  fs.writeFileSync(file, JSON.stringify({ ...f.value, env: { CODEBUDDY_AUTH_TOKEN: 'x' } }));
  assert.throws(() => loadManifest(file), /Unknown HY4 manifest field: env/);
});

test('ACP probe is prompt-free and pins hy4free/dontAsk', async () => {
  const { manager, workspace } = managerFor('normal');
  const status = await manager.probe();
  assert.equal(status.ready, true);
  assert.equal(status.model, 'hy4free');
  assert.equal(status.permission_mode, 'dontAsk');
  assert.equal(status.tools, 'disabled');
  assert.deepEqual(status.capabilities, { 'text-only': true, 'workspace-read': false, 'workspace-write': false });
  await manager.close();
  assert.ok(fs.existsSync(workspace));
});

test('ACP run returns only the sanitized terminal answer and no prompt/receipt text', async () => {
  const { manager, workspace } = managerFor('normal');
  const result = await manager.run(task(workspace));
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'HY4_OK');
  assert.equal(result.tool_events, 0);
  assert.equal(result.selected_model, 'hy4free');
  assert.equal(result.permission_mode, 'dontAsk');
  assert.equal(result.acp_permission_mode, 'dontAsk');
  const text = fs.readFileSync(path.join(manager.root, fs.readdirSync(manager.root).find(x => x.endsWith('.json'))), 'utf8');
  assert.ok(!text.includes('fixture prompt'));
  assert.ok(!text.includes('sk-'));
  const again = await manager.run(task(workspace));
  assert.equal(again.task_id, result.task_id);
  await manager.close();
});

test('pin mismatch, permission mismatch and auth gate fail closed before prompt', async () => {
  for (const mode of ['pin-mismatch', 'permission-mismatch', 'auth-gate']) {
    const { manager, workspace } = managerFor(mode);
    const status = await manager.probe();
    assert.equal(status.ready, false, mode);
    await assert.rejects(manager.start(task(workspace, 'x', `key-${mode}`)), e => e instanceof Error, mode);
    await manager.close();
  }
});

test('free catalog guard rejects missing and nonzero hy4free pricing before prompt', async () => {
  for (const mode of ['free-missing', 'free-price']) {
    const { manager, workspace } = managerFor(mode);
    try {
      const key = `free-catalog-${mode}`;
      await assert.rejects(manager.start(task(workspace, 'free guard', key)), error => {
        assert.equal(error.details?.code, 'HY4_FREE_CATALOG_UNVERIFIED');
        return true;
      });
      const receipt = manager._read(manager._receiptPath(key));
      assert.equal(receipt.state, 'not_accepted');
      assert.equal(receipt.answer, '');
      assert.equal(receipt.error_code, 'HY4_FREE_CATALOG_UNVERIFIED');
    } finally { await manager.close(); }
  }
});

test('availableModels-only hy4free catalog at x0.00 credits is accepted', async () => {
  const { manager } = managerFor('free-models-only');
  try {
    const status = await manager.probe();
    assert.equal(status.ready, true);
    assert.equal(status.free_catalog_verified, true);
    assert.equal(status.billing_attestation, false);
  } finally { await manager.close(); }
});

test('permission denial is a terminal refusal, not a successful answer', async () => {
  const { manager, workspace, config } = managerFor('deny');
  const result = await manager.run(task(workspace));
  assert.equal(result.status, 'failed');
  assert.equal(result.state, 'refused');
  assert.equal(result.error_code, 'HY4_PERMISSION_DENIED');
  assert.equal(result.answer, '');
  await manager.close();
  assert.ok(fs.existsSync(config));
});

test('partial ACP response becomes unknown and the same key is never resubmitted', async () => {
  const { manager, workspace } = managerFor('partial');
  const started = await manager.start(task(workspace, 'partial task', 'partial-key'));
  const terminal = await manager.wait(started.task_id, 5000);
  assert.equal(terminal.state, 'unknown');
  const again = await manager.start(task(workspace, 'partial task', 'partial-key'));
  assert.equal(again.task_id, started.task_id);
  await manager.close();
});

test('owner-only cancellation stops a slow owned child', async () => {
  const { manager, workspace } = managerFor('slow');
  const started = await manager.start(task(workspace, 'slow task', 'slow-key'));
  const cancelled = await manager.cancel(started.task_id);
  assert.equal(cancelled.status, 'cancelled');
  await manager.close();
});

test('unexpected tool events are fail-closed, never a completed answer', async () => {
  const { manager, workspace } = managerFor('tool-event');
  const result = await manager.run(task(workspace, 'tool task', 'tool-key'));
  assert.notEqual(result.status, 'completed');
  assert.ok(result.tool_events >= 1);
  assert.equal(result.error_code, 'HY4_UNEXPECTED_TOOL_EVENT');
  await manager.close();
});

test('mid-turn model changes are fail-closed', async () => {
  const { manager, workspace } = managerFor('model-change');
  const result = await manager.run(task(workspace, 'model task', 'model-key'));
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'HY4_RUNTIME_MODEL_MISMATCH');
  await manager.close();
});

test('workspace and permission boundaries are enforced before spawn', async () => {
  const { manager, workspace } = managerFor('normal');
  assert.throws(() => canonicalWithin(workspace, path.dirname(workspace)), /outside/);
  await assert.rejects(manager.start({ ...task(workspace), cwd: path.dirname(workspace) }));
  await assert.rejects(manager.start({ ...task(workspace), permissionMode: 'workspace-write' }), e =>
    e.details?.code === 'HY4_READ_ONLY_CAPABILITY');
  await manager.close();
});

test('ordinary read-only without text-only capability never falls back', async () => {
  const { manager, workspace } = managerFor('normal');
  await manager.probe();
  const dsh = { calls: 0, async submit() { this.calls++; throw new PreAdmissionRejection(AdmissionCode.SCHEDULE_GATE, 'schedule', { details: { phase: 'peak' } }); } };
  const coordinator = new RoutingCoordinator({ runtime: temp(), dsh, hy4: manager, authorization: auth });
  await assert.rejects(coordinator.submit(task(workspace, 'ordinary', 'ordinary-key')), e =>
    e.code === AdmissionCode.PERMISSION_REFUSED && e.decision.selected_backend === 'none');
  assert.equal(dsh.calls, 1);
  await manager.close();
});

test('workspace-read is opt-in and carries its exact route capability', async () => {
  const { manager, workspace } = managerFor('normal', { allow_workspace_read: true });
  assert.equal(manager.supports('workspace-read'), true);
  assert.equal(manager.supports('workspace-write'), false);
  const started = await manager.start({ ...task(workspace, 'read task', 'read-key') }, 'workspace-read');
  const result = await manager.wait(started.task_id, 5000);
  assert.equal(result.capability, 'workspace-read');
  assert.equal(result.tools, 'Read,Glob,Grep');
  assert.equal(result.status, 'completed');
  await manager.close();
});

test('coordinator fallback uses the real ACP adapter only after a structured schedule rejection', async () => {
  const { manager, workspace } = managerFor('normal');
  const dsh = { calls: 0, async submit() { this.calls++; throw new PreAdmissionRejection(AdmissionCode.SCHEDULE_GATE, 'schedule', { details: { phase: 'peak' } }); } };
  const coordinator = new RoutingCoordinator({ runtime: temp(), dsh, hy4: manager, authorization: auth });
  const decision = await coordinator.submit(textTask(workspace, 'fallback task', 'fallback-key'));
  assert.equal(decision.selected_backend, 'hy4');
  assert.equal(decision.admission_state, 'accepted');
  assert.equal(decision.task_capability, 'text-only');
  assert.equal(decision.dsh.code, AdmissionCode.SCHEDULE_GATE);
  assert.equal(dsh.calls, 1);
  const receipt = await manager.wait(decision.task_id, 5000);
  assert.equal(receipt.status, 'completed');
  await manager.close();
});

test('explicit HY4 never calls DSH and receives only HY4', async () => {
  const { manager, workspace } = managerFor('normal');
  const dsh = { calls: 0, async submit() { this.calls++; return { task_id: 'dsh-should-not-run' }; } };
  const coordinator = new RoutingCoordinator({ runtime: temp(), dsh, hy4: manager, authorization: auth });
  const decision = await coordinator.submit(textTask(workspace, 'explicit', 'explicit-key'), { sessionMode: 'HY4' });
  assert.equal(decision.selected_backend, 'hy4');
  assert.equal(dsh.calls, 0);
  assert.equal((await manager.wait(decision.task_id, 5000)).status, 'completed');
  await manager.close();
});

test('opt-in server refuses a shared HY4/DSH runtime', async () => {
  const f = fixture('normal'), shared = temp();
  const p = spawn(process.execPath, [path.join(root, 'bridges', 'hy4', 'server.mjs'),
    '--hy4-manifest', f.file, '--runtime', shared, '--dsh-runtime', shared,
    '--routing-runtime', temp(), '--dsh-entry', path.join(root, 'tests', 'mock-dsh.mjs')
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const code = await Promise.race([
    new Promise(resolve => p.on('close', resolve)),
    new Promise(resolve => setTimeout(() => { p.kill(); resolve('timeout'); }, 5000))
  ]);
  assert.equal(code, 1);
});

test('opt-in MCP endpoint serves status and an explicit HY4 run with fixtures', async () => {
  const f = fixture('normal');
  const runtime = temp(), dshRuntime = temp(), routingRuntime = temp();
  const p = spawn(process.execPath, [path.join(root, 'bridges', 'hy4', 'server.mjs'),
    '--hy4-manifest', f.file, '--runtime', runtime, '--dsh-runtime', dshRuntime,
    '--routing-runtime', routingRuntime, '--dsh-entry', path.join(root, 'tests', 'mock-dsh.mjs'),
    '--fallback-authorization', 'fixture-approval'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = ''; const pending = new Map();
  p.stdout.setEncoding('utf8'); p.stdout.on('data', data => {
    buffer += data; let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const v = JSON.parse(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1);
      const entry = pending.get(v.id); if (entry) { clearTimeout(entry.timer); entry.resolve(v); pending.delete(v.id); }
    }
  });
  p.on('error', error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  });
  p.on('exit', code => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error(`bridge exited ${code}`)); }
    pending.clear();
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => reject(Error('MCP timeout')), 15000);
    pending.set(id, { resolve, reject, timer });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const status = await rpc('tools/call', { name: 'get_hy4_bridge_status', arguments: {} });
    const parsed = JSON.parse(status.result.content[0].text);
    assert.equal(parsed.hy4.ready, true);
    assert.equal(parsed.hy4.model, 'hy4free');
    const run = await rpc('tools/call', { name: 'run_hy4_task', arguments: textTask(f.workspace) });
    const receipt = JSON.parse(run.result.content[0].text).receipt;
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.answer, 'HY4_OK');
    const routedGet = await rpc('tools/call', { name: 'get_routed_task', arguments: { idempotencyKey: 'hy4-1' } });
    assert.equal(JSON.parse(routedGet.result.content[0].text).receipt.status, 'completed');
    const routed = await rpc('tools/call', { name: 'run_routed_task', arguments: textTask(f.workspace, 'routed', 'routed-key') });
    assert.equal(routed.result.isError, true);
    assert.equal(routed.result.structuredContent.error.code, AdmissionCode.PERMISSION_REFUSED);
  } finally {
    p.stdin.end();
    await new Promise(resolve => {
      if (p.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 5000);
      p.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (p.exitCode === null) p.kill();
  }
});
