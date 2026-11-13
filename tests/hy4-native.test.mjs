import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadManifest, sha256File } from '../bridges/hy4/manifest.mjs';
import { Hy4AcpManager } from '../bridges/hy4/acp.mjs';
import { sha256 } from '../bridges/hy4/policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = path.join(root, 'tests', 'fake-codebuddy-acp.mjs');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rule-hy4-native-'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const HOOK_SHELL = (() => {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
    : ['/bin/bash', '/bin/sh'];
  return candidates.find(value => { try { return fs.statSync(value).isFile(); } catch { return false; } }) ?? null;
})();
const COMMAND_TOOL = process.platform === 'win32' ? 'PowerShell' : 'Bash';
const EXACT_COMMAND = 'Write-Output HY4_OK';
const COMMANDS_TEST = Boolean(HOOK_SHELL) && process.env.HY4_TEST_COMMANDS === '1';

function fixture(mode, options = {}) {
  const dir = temp(), config = path.join(dir, 'config'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(config); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(config, 'mode.txt'), mode);
  const file = path.join(dir, 'manifest.json');
  const value = {
    schema: 1, node_path: process.execPath, cli_entry: fake, config_dir: config,
    workspace_root: workspace, expected_version: '2.184.0',
    expected_entry_sha256: sha256File(fake), internet_environment: 'internal',
    ...options
  };
  fs.writeFileSync(file, JSON.stringify(value));
  return { file, workspace, config, value };
}
function managerFor(mode, options = {}) {
  const f = fixture(mode, options);
  const manager = new Hy4AcpManager({ manifest: loadManifest(f.file), runtime: temp() });
  return { ...f, manager };
}
function writable(mode, options = {}) {
  return managerFor(mode, { allow_workspace_write: true, ...options });
}
function writeTask(workspace, key, extra = {}, prompt = 'native write fixture') {
  return {
    prompt, cwd: workspace, idempotencyKey: key, timeoutMs: 6000,
    permissionMode: 'workspace-write', capability: 'workspace-write',
    authorizationNote: 'native-write-test-approval', ...extra
  };
}
const textTask = (workspace, key, prompt = 'text fixture') => ({
  prompt, cwd: workspace, idempotencyKey: key, timeoutMs: 4000, permissionMode: 'read-only'
});

test('text-only still exposes no tools and never becomes a write task', async () => {
  const { manager, workspace } = managerFor('normal');
  try {
    const receipt = await manager.run(textTask(workspace, 'text-only'));
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.tools, '');
    assert.equal(receipt.allowed_operations, 0);
    assert.equal(receipt.completed_operations, 0);
    await assert.rejects(manager.start({ ...textTask(workspace, 'text-write'), permissionMode: 'workspace-write' }), error => {
      assert.equal(error.details?.code, 'HY4_READ_ONLY_CAPABILITY');
      return true;
    });
  } finally { await manager.close(); }
});

test('workspace-write creates an absent file and edits an existing file without precomputed content or hash', async () => {
  {
    const { manager, workspace } = writable('write-create');
    try {
      const target = path.join(workspace, 'created.txt');
      const receipt = await manager.run(writeTask(workspace, 'create-native', { writes: [{ path: target, mode: 'create' }] }));
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.state, 'completed');
      assert.equal(receipt.allowed_operations, 1);
      assert.equal(receipt.completed_operations, 1);
      assert.equal(fs.readFileSync(target, 'utf8'), 'CREATED\n');
      const publicBytes = JSON.stringify(receipt);
      assert.ok(!publicBytes.includes('created.txt'));
      assert.ok(!publicBytes.includes('CREATED'));
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = writable('write-edit');
    try {
      const target = path.join(workspace, 'existing.txt');
      fs.writeFileSync(target, 'OLD\n');
      const receipt = await manager.run(writeTask(workspace, 'edit-native', { writes: [{ path: target, mode: 'edit' }] }));
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.allowed_operations, 1);
      assert.equal(fs.readFileSync(target, 'utf8'), 'NEW\n');
    } finally { await manager.close(); }
  }
});

test('write on an absent exact file is create, and a create operation scope permits normal nested writes', async () => {
  {
    const { manager, workspace } = writable('write-create');
    try {
      const target = path.join(workspace, 'created.txt');
      const receipt = await manager.run(writeTask(workspace, 'write-absent', { writes: [{ path: target, mode: 'write' }] }));
      assert.equal(receipt.status, 'completed');
      assert.ok(fs.existsSync(target));
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = writable('write-nested');
    try {
      fs.mkdirSync(path.join(workspace, 'nested', 'deep'), { recursive: true });
      const receipt = await manager.run(writeTask(workspace, 'nested-write', {
        writeScopes: [{ path: workspace, operations: ['create'] }]
      }));
      assert.equal(receipt.status, 'completed');
      assert.equal(fs.readFileSync(path.join(workspace, 'nested', 'deep', 'file.txt'), 'utf8'), 'NESTED\n');
    } finally { await manager.close(); }
  }
});

test('outside exact paths and sensitive lexical paths are rejected before spawn', async () => {
  const { manager, workspace } = writable('normal');
  try {
    const outside = path.join(path.dirname(workspace), 'outside.txt');
    for (const [key, target, code] of [
      ['outside-exact', outside, 'HY4_INVALID_TASK'],
      ['sensitive-exact', path.join(workspace, '.env.fixture'), 'HY4_INVALID_TASK'],
      ['ads-exact', path.join(workspace, 'safe.txt:stream'), 'HY4_INVALID_TASK'],
      ['device-exact', path.join(workspace, 'CON'), 'HY4_INVALID_TASK'],
      ['edit-hash', path.join(workspace, 'edit.txt'), 'HY4_INVALID_TASK']
    ]) {
      const extra = key === 'edit-hash'
        ? { writes: [{ path: target, mode: 'edit', content_sha256: 'a'.repeat(64) }] }
        : { writes: [{ path: target, mode: 'write' }] };
      await assert.rejects(manager.start(writeTask(workspace, key, extra)), error => {
        assert.equal(error.details?.code, code, key);
        return true;
      });
    }
  } finally { await manager.close(); }
});

test('runtime write callbacks outside the approved path, scope, or a junction are denied', async () => {
  {
    const { manager, workspace } = writable('write-outside', { allow_workspace_write: true });
    try {
      const receipt = await manager.run(writeTask(workspace, 'outside-runtime', {
        writeScopes: [{ path: workspace, operations: ['create'] }]
      }));
      assert.equal(receipt.status, 'failed');
      assert.ok(receipt.denied_operations >= 1);
      assert.ok(!fs.existsSync(path.join(path.dirname(workspace), 'outside.txt')));
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = writable('write-sensitive');
    try {
      const receipt = await manager.run(writeTask(workspace, 'sensitive-runtime', {
        writeScopes: [{ path: workspace, operations: ['create'] }]
      }));
      assert.equal(receipt.status, 'failed');
      assert.ok(receipt.denied_operations >= 1);
      assert.ok(!fs.existsSync(path.join(workspace, '.env.fixture')));
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = writable('write-symlink');
    const outside = temp();
    try {
      const link = path.join(workspace, 'link');
      try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch { return; }
      const receipt = await manager.run(writeTask(workspace, 'symlink-runtime', {
        writeScopes: [{ path: workspace, operations: ['create'] }]
      }));
      assert.equal(receipt.status, 'failed');
      assert.ok(receipt.denied_operations >= 1);
      assert.ok(!fs.existsSync(path.join(outside, 'escaped.txt')));
    } finally { await manager.close(); }
  }
});

test('scope outside the target, edit-created files and mixed terminal states fail safely', async () => {
  {
    const { manager, workspace } = writable('write-outside-scope');
    try {
      fs.mkdirSync(path.join(workspace, 'nested'));
      const receipt = await manager.run(writeTask(workspace, 'outside-scope', {
        writeScopes: [{ path: path.join(workspace, 'nested'), operations: ['create'] }]
      }));
      assert.equal(receipt.status, 'failed');
      assert.ok(receipt.denied_operations >= 1);
      assert.ok(!fs.existsSync(path.join(workspace, 'other.txt')));
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = writable('write-edit-absent');
    try {
      const target = path.join(workspace, 'absent-edit.txt');
      const receipt = await manager.run(writeTask(workspace, 'edit-absent', {
        writeScopes: [{ path: workspace, operations: ['edit'] }]
      }));
      assert.equal(receipt.status, 'failed');
      assert.ok(receipt.denied_operations >= 1);
      assert.ok(!fs.existsSync(target));
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = writable('write-mixed');
    try {
      const receipt = await manager.run(writeTask(workspace, 'mixed-write', {
        writes: [{ path: path.join(workspace, 'ok.txt'), mode: 'create' }]
      }));
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.state, 'partial');
      assert.equal(receipt.allowed_operations, 1);
      assert.equal(receipt.completed_operations, 1);
      assert.ok(receipt.denied_operations >= 1);
    } finally { await manager.close(); }
  }
});

test('one toolCallId per file does not block a later in-scope edit; unconfirmed completion is not success', async () => {
  {
    const { manager, workspace } = writable('write-repeat');
    try {
      const target = path.join(workspace, 'repeat.txt');
      const receipt = await manager.run(writeTask(workspace, 'repeat-write', {
        writeScopes: [{ path: workspace, operations: ['create', 'replace'] }]
      }));
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.allowed_operations, 2);
      assert.equal(receipt.completed_operations, 2);
      assert.equal(fs.readFileSync(target, 'utf8'), 'TWO\n');
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = writable('write-no-complete');
    try {
      const target = path.join(workspace, 'unconfirmed.txt');
      const receipt = await manager.run(writeTask(workspace, 'unconfirmed-write', { writes: [{ path: target, mode: 'create' }] }));
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.error_code, 'HY4_OPERATION_NOT_CONFIRMED');
      assert.equal(receipt.state, 'failed');
    } finally { await manager.close(); }
  }
});

test('Windows file URI locations are converted with fileURLToPath', async () => {
  const { manager, workspace } = writable('write-file-uri');
  try {
    const receipt = await manager.run(writeTask(workspace, 'uri-write', {
      writeScopes: [{ path: workspace, operations: ['create'] }]
    }));
    assert.equal(receipt.status, 'completed');
    assert.equal(fs.readFileSync(path.join(workspace, 'uri.txt'), 'utf8'), 'URI\n');
  } finally { await manager.close(); }
});

test('content hashes apply only to full-content writes and are checked when supplied', async () => {
  {
    const { manager, workspace } = writable('write-hash-ok');
    try {
      const target = path.join(workspace, 'hashed.txt');
      const receipt = await manager.run(writeTask(workspace, 'hash-ok', {
        writes: [{ path: target, mode: 'create', content_sha256: sha256('HASHED\n') }]
      }));
      assert.equal(receipt.status, 'completed');
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = writable('write-hash-bad');
    try {
      const target = path.join(workspace, 'hashed.txt');
      const receipt = await manager.run(writeTask(workspace, 'hash-bad', {
        writes: [{ path: target, mode: 'create', content_sha256: sha256('HASHED\n') }]
      }));
      assert.equal(receipt.status, 'failed');
      assert.ok(receipt.denied_operations >= 1);
      assert.ok(!fs.existsSync(target));
    } finally { await manager.close(); }
  }
});

test('session_info_update is benign and repeated tool_call details count as one read operation', async () => {
  const { manager, workspace } = managerFor('read-repeat', { allow_workspace_read: true });
  try {
    fs.writeFileSync(path.join(workspace, 'readme.txt'), 'READ_OK\n');
    const receipt = await manager.run({
      prompt: 'read repeat fixture', cwd: workspace, idempotencyKey: 'read-repeat',
      timeoutMs: 4000, permissionMode: 'read-only', capability: 'workspace-read'
    });
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.error_code, null);
    assert.equal(receipt.observed_operations, 1);
    assert.equal(receipt.completed_operations, 1);
  } finally { await manager.close(); }
});

test('workspace-read rejects read locations outside cwd and the synthetic .env.fixture', async () => {
  for (const mode of ['read-outside', 'read-sensitive']) {
    const { manager, workspace } = managerFor(mode, { allow_workspace_read: true });
    try {
      const receipt = await manager.run({
        prompt: 'read fixture', cwd: workspace, idempotencyKey: `read-${mode}`,
        timeoutMs: 4000, permissionMode: 'read-only', capability: 'workspace-read'
      });
      assert.equal(receipt.status, 'failed', mode);
      assert.equal(receipt.error_code, 'HY4_OUTSIDE_READ', mode);
      assert.equal(receipt.answer, '', mode);
    } finally { await manager.close(); }
  }
});

test('native commands are gated by the local manifest, exact task lines and the PreToolUse hook', { skip: !COMMANDS_TEST }, async () => {
  const options = { allow_workspace_write: true, allow_commands: true, hook_shell_path: HOOK_SHELL };
  {
    const { manager, workspace } = managerFor('command-allow', options);
    try {
      const receipt = await manager.run(writeTask(workspace, 'command-allow', { commands: [EXACT_COMMAND] }));
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.command_count, 1);
      assert.equal(receipt.command_tool, COMMAND_TOOL);
      assert.equal(receipt.command_enforcement, 'pretooluse_hook_configured');
      assert.equal(receipt.allowed_operations, 1);
      assert.equal(receipt.completed_operations, 1);
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = managerFor('command-auto', options);
    try {
      const receipt = await manager.run(writeTask(workspace, 'command-auto', { commands: [EXACT_COMMAND] }));
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.allowed_operations, 0);
      assert.equal(receipt.auto_approved_operations, 1);
      assert.equal(receipt.completed_operations, 1);
    } finally { await manager.close(); }
  }
  {
    const { manager, workspace } = managerFor('command-unrelated', options);
    try {
      const receipt = await manager.run(writeTask(workspace, 'command-unrelated', { commands: [EXACT_COMMAND] }));
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.error_code, 'HY4_COMMAND_NOT_AUTHORIZED');
    } finally { await manager.close(); }
  }
});

test('command tools are absent without a command list and malformed command rules fail closed', async () => {
  {
    const { manager, workspace } = writable('write-create');
    try {
      const target = path.join(workspace, 'created.txt');
      const receipt = await manager.run(writeTask(workspace, 'no-command', { writes: [{ path: target, mode: 'create' }] }));
      assert.equal(receipt.status, 'completed');
      assert.ok(!receipt.tools.includes(COMMAND_TOOL));
      assert.equal(receipt.command_count, 0);
    } finally { await manager.close(); }
  }
  const { manager, workspace } = writable('normal');
  try {
    for (const [key, command] of [
      ['redirect', 'Write-Output x > out.txt'],
      ['background', 'Write-Output x &'],
      ['separator', 'Write-Output x; Write-Output y'],
      ['bypass', 'node --no-sandbox script.mjs']
    ]) {
      await assert.rejects(manager.start(writeTask(workspace, `bad-command-${key}`, { commands: [command] })), error => {
        assert.equal(error.details?.code, 'HY4_INVALID_TASK', key);
        return true;
      });
    }
  } finally { await manager.close(); }
});

test('idempotency identity includes normalized scope and old receipts never silently replay', async () => {
  const { manager, workspace } = writable('write-create');
  try {
    const firstTarget = path.join(workspace, 'first.txt');
    const started = await manager.start(writeTask(workspace, 'scope-identity', { writes: [{ path: firstTarget, mode: 'create' }] }));
    const replay = await manager.start(writeTask(workspace, 'scope-identity', { writes: [{ path: firstTarget, mode: 'create' }] }));
    assert.equal(replay.task_id, started.task_id);
    await assert.rejects(manager.start(writeTask(workspace, 'scope-identity', {
      writes: [{ path: path.join(workspace, 'second.txt'), mode: 'create' }]
    })), error => {
      assert.equal(error.details?.code, 'HY4_IDEMPOTENCY_CONFLICT');
      return true;
    });

    const legacyTaskId = '11111111-1111-4111-8111-111111111111';
    const legacyFile = manager._receiptPath('legacy-key');
    fs.writeFileSync(legacyFile, JSON.stringify({
      schema: 1, task_id: legacyTaskId, backend: 'hy4', state: 'completed', status: 'completed',
      prompt_sha256: digest('legacy prompt'), cwd: workspace, capability: 'text-only'
    }));
    assert.equal(manager.get(legacyTaskId).task_id, legacyTaskId);
    await assert.rejects(manager.start({
      ...textTask(workspace, 'legacy-key'), prompt: 'legacy prompt'
    }), error => {
      assert.equal(error.details?.code, 'HY4_IDEMPOTENCY_LEGACY_UNVERIFIABLE');
      return true;
    });
  } finally { await manager.close(); }
});
