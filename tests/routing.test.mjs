import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AdmissionCode, PreAdmissionRejection, RoutingCoordinator, RoutingDecisionError,
  RoutingConflictError, UnavailableWorkBuddyHy4, isFallbackEligible,
  validateFallbackAuthorization, ROUTING_POLICY_VERSION
} from '../bridges/dsh/routing.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rule-routing-'));
const task = (key = 'task-1', extra = {}) => ({
  prompt: 'PRIVATE-PROMPT-MUST-NOT-BE-STORED', cwd: temp(), idempotencyKey: key, timeoutMs: 1000, ...extra
});
const auth = Object.freeze({
  schema: 1, enabled: true, authorization_ref: 'user-approval-2026-11-13',
  scope: 'pre_admission_only', max_attempts: 1
});
const scheduleRejection = () => new PreAdmissionRejection(
  AdmissionCode.SCHEDULE_GATE,
  'DSH instance is blocked by the offpeak schedule (peak).',
  { phase: 'peak', next_offpeak_at: '2026-11-13T06:00:00.000Z' }
);
const acceptedDsh = { task_id: 'dsh-task-1', status: 'running' };
const acceptedHy4 = { task_id: 'hy4-task-1', status: 'running' };
const textTask = (key, extra = {}) => ({ ...task(key, extra), capability: 'text-only' });
const dsh = fn => ({ calls: 0, async submit(t) { this.calls++; return fn(t); } });
const hy4 = (fn, status = { ready: true, backend: 'hy4', model: 'hy4free' }) => ({
  calls: 0, status() { return status; }, async submit(t) { this.calls++; return fn(t); }
});

test('policy is candidate-only and the default HY4 adapter is fail-closed', () => {
  const adapter = new UnavailableWorkBuddyHy4();
  const status = adapter.status();
  assert.equal(status.ready, false);
  assert.equal(status.reason_code, 'HY4_ROUTE_UNVERIFIED');
  assert.match(status.missing_entry, /hy4free/);
  assert.equal(status.local_evidence.model_availability_proven, false);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: dsh(() => acceptedDsh), authorization: auth });
  const snapshot = c.status();
  assert.equal(snapshot.policy_version, ROUTING_POLICY_VERSION);
  assert.equal(snapshot.default_backend, 'dsh');
  assert.equal(snapshot.live_mcp_dispatch_wired, false);
  assert.equal(snapshot.candidate_only, true);
  assert.equal(snapshot.hy4.ready, false);
});

test('authorization requires an explicit, narrow, single-attempt reference', () => {
  assert.equal(validateFallbackAuthorization(null).enabled, false);
  assert.throws(() => validateFallbackAuthorization({ ...auth, authorization_ref: undefined }), /authorization_ref/);
  assert.throws(() => validateFallbackAuthorization({ ...auth, scope: 'always' }), /pre_admission_only/);
  assert.throws(() => validateFallbackAuthorization({ ...auth, max_attempts: 2 }), /exactly one/);
  assert.throws(() => validateFallbackAuthorization({ ...auth, enabled: 'yes' }), /enabled: true/);
  assert.equal(validateFallbackAuthorization(auth).max_attempts, 1);
});

test('eligible codes are a closed set, not message matching', () => {
  assert.equal(isFallbackEligible(scheduleRejection()), true);
  assert.equal(isFallbackEligible(new PreAdmissionRejection(
    AdmissionCode.PRE_ACCEPTANCE_UNAVAILABLE, 'quota probe',
    { evidence: { provider_check: 'supported', task_accepted: false, cause: 'quota_exhausted' } }
  )), true);
  assert.equal(isFallbackEligible(new PreAdmissionRejection(
    AdmissionCode.PRE_ACCEPTANCE_UNAVAILABLE, 'quota probe', { evidence: { cause: 'quota_exhausted' } }
  )), false);
  for (const code of [
    AdmissionCode.BUSY, AdmissionCode.LOCKED, AdmissionCode.INVALID_PARAMS,
    AdmissionCode.PERMISSION_REFUSED, AdmissionCode.PREFLIGHT_FAILED,
    AdmissionCode.SESSION_CONFLICT
  ]) {
    assert.equal(isFallbackEligible(new PreAdmissionRejection(code, 'blocked')), false, code);
  }
  assert.equal(isFallbackEligible(Error('DSH instance is blocked by the offpeak schedule (peak)')), false);
});

test('legitimate schedule gate falls back once to a ready HY4 adapter and audits the decision', async () => {
  const d = dsh(() => { throw scheduleRejection(); });
  const h = hy4(() => acceptedHy4);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: h, authorization: auth });
  const t = textTask('legit-schedule');
  const decision = await c.submit(t);
  assert.equal(decision.selected_backend, 'hy4');
  assert.equal(decision.admission_state, 'accepted');
  assert.equal(decision.reason_code, AdmissionCode.HY4_FALLBACK_ADMITTED);
  assert.equal(decision.task_id, 'hy4-task-1');
  assert.equal(decision.dsh.code, AdmissionCode.SCHEDULE_GATE);
  assert.equal(decision.fallback.attempted, true);
  assert.equal(d.calls, 1);
  assert.equal(h.calls, 1);
  const file = c.decisionPath('legit-schedule');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('PRIVATE-PROMPT-MUST-NOT-BE-STORED'));
  const stored = JSON.parse(text);
  assert.equal(stored.request_id, decision.request_id);
  assert.equal(stored.idempotency_key, 'legit-schedule');
  assert.match(stored.prompt_sha256, /^[a-f0-9]{64}$/);
});

test('fallback without explicit local authorization is refused and HY4 is never called', async () => {
  const h = hy4(() => acceptedHy4);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: dsh(() => { throw scheduleRejection(); }), hy4: h, authorization: null });
  await assert.rejects(c.submit(textTask('no-auth')), e => {
    assert.ok(e instanceof RoutingDecisionError);
    assert.equal(e.code, AdmissionCode.FALLBACK_NOT_AUTHORIZED);
    assert.equal(e.admission_state, 'not_accepted');
    assert.equal(e.decision.selected_backend, 'none');
    return true;
  });
  assert.equal(h.calls, 0);
});

test('explicit HY4 selection stays HY4 even when DSH is healthy', async () => {
  const d = dsh(() => acceptedDsh);
  const h = hy4(() => acceptedHy4);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: h, authorization: null });
  const decision = await c.submit(textTask('explicit-hy4'), { sessionMode: 'HY4' });
  assert.equal(decision.selected_backend, 'hy4');
  assert.equal(decision.reason_code, AdmissionCode.HY4_EXPLICIT_ADMITTED);
  assert.equal(d.calls, 0);
  assert.equal(h.calls, 1);
});

test('explicit HY4 with no ready route fails closed and does not fall back to DSH', async () => {
  const d = dsh(() => acceptedDsh);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: new UnavailableWorkBuddyHy4(), authorization: null });
  await assert.rejects(c.submit(textTask('explicit-hy4-down'), { sessionMode: 'HY4' }), e => {
    assert.equal(e.code, AdmissionCode.HY4_UNAVAILABLE);
    assert.equal(e.decision.selected_backend, 'hy4');
    assert.equal(e.decision.admission_state, 'not_accepted');
    return true;
  });
  assert.equal(d.calls, 0);
});

test('accepted DSH task locks the backend; no HY4 attempt and no duplicate submit', async () => {
  const d = dsh(() => acceptedDsh);
  const h = hy4(() => { throw Error('HY4 must not run'); });
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: h, authorization: auth });
  const t = task('dsh-accepted');
  const first = await c.submit(t);
  assert.equal(first.selected_backend, 'dsh');
  assert.equal(first.reason_code, AdmissionCode.DSH_ADMITTED);
  const replay = await c.submit(t);
  assert.equal(replay.request_id, first.request_id);
  assert.equal(d.calls, 1);
  assert.equal(h.calls, 0);
});

test('unstructured DSH failure is unknown, never a fallback trigger', async () => {
  const h = hy4(() => acceptedHy4);
  const c = new RoutingCoordinator({
    runtime: temp(), hy4: h, authorization: auth,
    dsh: dsh(() => { throw Error('socket hang up after possible launch'); })
  });
  await assert.rejects(c.submit(task('unknown-dsh')), e => {
    assert.equal(e.code, AdmissionCode.UNKNOWN);
    assert.equal(e.admission_state, 'unknown');
    assert.equal(e.decision.fallback.attempted, false);
    return true;
  });
  assert.equal(h.calls, 0);
});

test('busy, lock, invalid params, permission, session and preflight rejections never fall back', async () => {
  const codes = [
    AdmissionCode.BUSY, AdmissionCode.LOCKED, AdmissionCode.INVALID_PARAMS,
    AdmissionCode.PERMISSION_REFUSED, AdmissionCode.SESSION_CONFLICT, AdmissionCode.PREFLIGHT_FAILED
  ];
  for (const [index, code] of codes.entries()) {
    const h = hy4(() => acceptedHy4);
    const c = new RoutingCoordinator({
      runtime: temp(), hy4: h, authorization: auth,
      dsh: dsh(() => { throw new PreAdmissionRejection(code, `structured ${code}`); })
    });
    await assert.rejects(c.submit(task(`forbidden-${index}`)), e => e.code === code, code);
    assert.equal(h.calls, 0, `${code} must not reach HY4`);
  }
});

test('same-instance busy and lock are separate audit codes without automatic fallback', async () => {
  const h = hy4(() => acceptedHy4);
  const c = new RoutingCoordinator({
    runtime: temp(), hy4: h, authorization: auth,
    dsh: dsh(() => { throw new PreAdmissionRejection(AdmissionCode.BUSY, 'busy', { active_task_id: 'dsh-active' }); })
  });
  await assert.rejects(c.submit(task('busy-audit')), e => {
    assert.equal(e.code, AdmissionCode.BUSY);
    assert.equal(e.decision.dsh.code, AdmissionCode.BUSY);
    assert.equal(e.decision.fallback.eligible, false);
    return true;
  });
  assert.equal(h.calls, 0);
});

test('pre-admission auth/quota probe must be structured and only then may fall back', async () => {
  const h = hy4(() => acceptedHy4);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: dsh(() => acceptedDsh), hy4: h, authorization: auth });
  const decision = await c.submit(textTask('probe-quota'), {
    preAdmissionProbe: async () => ({ available: false, cause: 'quota_exhausted' })
  });
  assert.equal(decision.selected_backend, 'hy4');
  assert.equal(decision.dsh.code, AdmissionCode.PRE_ACCEPTANCE_UNAVAILABLE);
  assert.equal(decision.fallback.attempted, true);
  assert.equal(h.calls, 1);

  const h2 = hy4(() => acceptedHy4);
  const c2 = new RoutingCoordinator({ runtime: temp(), dsh: dsh(() => acceptedDsh), hy4: h2, authorization: auth });
  const d2 = await c2.submit(task('probe-ok'), { preAdmissionProbe: async () => ({ available: true }) });
  assert.equal(d2.selected_backend, 'dsh');
  assert.equal(h2.calls, 0);
});

test('schedule rejection with no verified HY4 route fails closed, not fabricated', async () => {
  const c = new RoutingCoordinator({
    runtime: temp(), dsh: dsh(() => { throw scheduleRejection(); }),
    hy4: new UnavailableWorkBuddyHy4(), authorization: auth
  });
  await assert.rejects(c.submit(textTask('hy4-down')), e => {
    assert.equal(e.code, AdmissionCode.HY4_UNAVAILABLE);
    assert.equal(e.admission_state, 'not_accepted');
    assert.equal(e.decision.selected_backend, 'none');
    assert.equal(e.decision.fallback.result, 'unavailable');
    assert.match(e.decision.hy4.code, /HY4_ROUTE_UNVERIFIED/);
    return true;
  });
});

test('concurrent same-key submissions share one dispatch and one request ID', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const d = { calls: 0, async submit() { this.calls++; await gate; return acceptedDsh; } };
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const t = task('concurrent');
  const p1 = c.submit(t);
  const p2 = c.submit(t);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.request_id, b.request_id);
  assert.equal(d.calls, 1);
  const replay = await c.submit(t);
  assert.equal(replay.request_id, a.request_id);
  assert.equal(d.calls, 1);
});

test('idempotency conflict and in-flight decision are not silent successes', async () => {
  const d = dsh(() => acceptedDsh);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const t = task('conflict');
  await c.submit(t);
  await assert.rejects(c.submit({ ...t, prompt: 'different work' }), e => e instanceof RoutingConflictError);
  assert.equal(d.calls, 1);
  assert.equal(c.get('never-seen'), null);

  const unknown = {
    schema: 1, policy_version: ROUTING_POLICY_VERSION, request_id: 'r', idempotency_key: 'inflight',
    idempotency_key_sha256: 'x', request_fingerprint: 'y', session_mode: 'DSH', requested_backend: 'dsh',
    selected_backend: 'dsh', admission_state: 'dispatching', reason_code: null, reason: null, task_id: null,
    prompt_sha256: 'z', cwd: t.cwd, permission_mode: 'read-only', fallback: {}, dsh: {}, hy4: {},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  const c2 = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  fs.writeFileSync(c2.decisionPath('inflight'), JSON.stringify(unknown));
  await assert.rejects(c2.submit(task('inflight')), e => e.code === 'ROUTING_IN_FLIGHT_OR_UNKNOWN');
});

test('idempotent accepted receipt remains readable during a schedule gate', async () => {
  let peak = false;
  const d = { calls: 0, async submit() { this.calls++; if (peak) throw scheduleRejection(); return acceptedDsh; } };
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const t = task('peak-lookup');
  const first = await c.submit(t);
  peak = true;
  const replay = await c.submit(t);
  assert.equal(replay.task_id, first.task_id);
  assert.equal(replay.admission_state, 'accepted');
  assert.equal(d.calls, 1);
});

test('untrusted error text cannot manufacture eligibility', async () => {
  const h = hy4(() => acceptedHy4);
  const c = new RoutingCoordinator({
    runtime: temp(), hy4: h, authorization: auth,
    dsh: dsh(() => { throw new Error(`${AdmissionCode.SCHEDULE_GATE} peak`); })
  });
  await assert.rejects(c.submit(task('string-spoof')), e => e.code === AdmissionCode.UNKNOWN);
  assert.equal(h.calls, 0);
});

test('two coordinator instances share one durable claim and inspect dispatching before submit', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const d = { calls: 0, async submit() { this.calls++; await gate; return acceptedDsh; } };
  const runtime = temp();
  const a = new RoutingCoordinator({ runtime, dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const b = new RoutingCoordinator({ runtime, dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const t = task('shared-claim');
  const first = a.submit(t);
  const claim = JSON.parse(fs.readFileSync(a.claimPath('shared-claim'), 'utf8'));
  const during = JSON.parse(fs.readFileSync(a.decisionPath('shared-claim'), 'utf8'));
  assert.equal(during.admission_state, 'dispatching');
  assert.equal(claim.request_id, during.request_id);
  assert.equal(d.calls, 1);
  await assert.rejects(b.submit(t), e => e.code === 'ROUTING_IN_FLIGHT_OR_UNKNOWN');
  assert.equal(d.calls, 1);
  release();
  const accepted = await first;
  assert.equal(accepted.admission_state, 'accepted');
  assert.equal((await b.submit(t)).request_id, accepted.request_id);
  assert.equal(d.calls, 1);
});

test('a durable claim survives missing/corrupt receipts and prevents retries', async () => {
  const d = dsh(() => acceptedDsh);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const t = task('claim-keep');
  await c.submit(t);
  fs.rmSync(c.decisionPath('claim-keep'));
  await assert.rejects(c.submit(t), e => e.code === 'ROUTING_IN_FLIGHT_OR_UNKNOWN');
  assert.equal(d.calls, 1);

  const c2 = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  fs.writeFileSync(c2.claimPath('corrupt-claim'), '{not-json');
  await assert.rejects(c2.submit(task('corrupt-claim')), e => e.code === 'ROUTING_IN_FLIGHT_OR_UNKNOWN');
});

test('a failed post-acceptance decision write leaves the claim closed', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const d = { calls: 0, async submit() { this.calls++; await gate; return acceptedDsh; } };
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const t = task('post-accept-write');
  const pending = c.submit(t);
  fs.rmSync(c.decisionPath('post-accept-write'));
  fs.mkdirSync(c.decisionPath('post-accept-write'));
  release();
  await assert.rejects(pending);
  assert.ok(fs.existsSync(c.claimPath('post-accept-write')));
  fs.rmSync(c.decisionPath('post-accept-write'), { recursive: true, force: true });
  await assert.rejects(c.submit(t), e => e.code === 'ROUTING_IN_FLIGHT_OR_UNKNOWN');
  assert.equal(d.calls, 1);
});

test('session continuation and repair requests never fall back even on schedule gate', async () => {
  for (const [key, extra, options] of [
    ['session-lock', { sessionId: 'sess-1' }, {}],
    ['continuation-lock', {}, { continuationOfTaskId: 'dsh-task-old' }],
    ['repair-lock', {}, { repairOfTaskId: 'dsh-task-old' }]
  ]) {
    const h = hy4(() => acceptedHy4);
    const c = new RoutingCoordinator({
      runtime: temp(), hy4: h, authorization: auth,
      dsh: dsh(() => { throw scheduleRejection(); })
    });
    await assert.rejects(c.submit(task(key, extra), options), e => {
      assert.equal(e.code, AdmissionCode.SCHEDULE_GATE);
      assert.equal(e.decision.fallback.eligible, false);
      assert.equal(e.decision.fallback.blocked_reason, 'session_continuation_or_repair_is_dsh_only');
      return true;
    });
    assert.equal(h.calls, 0, key);
  }
});

test('cross-mode reuse of a key is a conflict, not a prior task', async () => {
  const d = dsh(() => acceptedDsh);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const t = textTask('mode-identity');
  await c.submit(t);
  await assert.rejects(c.submit(t, { sessionMode: 'HY4' }), e => e instanceof RoutingConflictError);
  assert.equal(d.calls, 1);

  const d2 = dsh(() => acceptedDsh);
  const h2 = hy4(() => acceptedHy4);
  const c2 = new RoutingCoordinator({ runtime: temp(), dsh: d2, hy4: h2, authorization: auth });
  const t2 = textTask('mode-identity-2');
  await c2.submit(t2, { sessionMode: 'HY4' });
  await assert.rejects(c2.submit(t2), e => e instanceof RoutingConflictError);
  assert.equal(d2.calls, 0);
});

test('validation and permission refusal happen before any probe or fallback', async () => {
  let probed = false;
  const h = hy4(() => acceptedHy4);
  const c = new RoutingCoordinator({ runtime: temp(), dsh: dsh(() => acceptedDsh), hy4: h, authorization: auth });
  const probe = async () => { probed = true; return { available: false, cause: 'quota_exhausted' }; };
  await assert.rejects(c.submit(task('bad-timeout', { timeoutMs: 1 }), { preAdmissionProbe: probe }), e => e.code === AdmissionCode.INVALID_PARAMS);
  await assert.rejects(c.submit(task('bad-cwd', { cwd: path.join(temp(), 'missing') }), { preAdmissionProbe: probe }), e => e.code === AdmissionCode.INVALID_PARAMS);
  await assert.rejects(c.submit(task('bad-write', { permissionMode: 'workspace-write', authorizationNote: 'ref' }), { preAdmissionProbe: probe }), e => e.code === AdmissionCode.PERMISSION_REFUSED);
  assert.equal(probed, false);
  assert.equal(h.calls, 0);
});

test('receipts never store prompts, secrets, or raw adapter status text', async () => {
  const secret = 'SYNTHETIC-ROUTING-METADATA-MUST-NOT-APPEAR';
  const misleading = {
    ready: false,
    reason_code: secret,
    missing_entry: secret,
    next_step: secret,
    status: secret
  };
  const h = { calls: 0, status() { return misleading; }, async submit() { throw new Error(secret); } };
  const c = new RoutingCoordinator({
    runtime: temp(), hy4: h, authorization: auth,
    dsh: dsh(() => { throw scheduleRejection(); })
  });
  await assert.rejects(c.submit(textTask('secret-receipt')));
  const bytes = fs.readFileSync(c.decisionPath('secret-receipt'), 'utf8');
  assert.ok(!bytes.includes(secret));
  assert.ok(!bytes.includes('PRIVATE-PROMPT-MUST-NOT-BE-STORED'));
  assert.match(bytes, /HY4_ROUTE_UNVERIFIED/);

  const c2 = new RoutingCoordinator({
    runtime: temp(), hy4: hy4(() => acceptedHy4), authorization: auth,
    dsh: dsh(() => { throw new Error(`post-launch ${secret}`); })
  });
  await assert.rejects(c2.submit(task('secret-generic')));
  const bytes2 = fs.readFileSync(c2.decisionPath('secret-generic'), 'utf8');
  assert.ok(!bytes2.includes(secret));
  assert.ok(!bytes2.includes('post-launch'));
});

test('same-key concurrent differing inputs are rejected even if first submission fails', async () => {
  let rejectGate;
  const gate = new Promise((resolve, reject) => { rejectGate = reject; });
  const d = { calls: 0, async submit() { this.calls++; return gate; } };
  const c = new RoutingCoordinator({ runtime: temp(), dsh: d, hy4: hy4(() => acceptedHy4), authorization: auth });
  const t = task('concurrent-failure');
  const first = c.submit(t);
  await assert.rejects(c.submit({ ...t, prompt: 'different work' }), e => e instanceof RoutingConflictError);
  rejectGate(new Error('adapter failure'));
  await assert.rejects(first, e => e.code === AdmissionCode.UNKNOWN);
  assert.equal(d.calls, 1);
});

