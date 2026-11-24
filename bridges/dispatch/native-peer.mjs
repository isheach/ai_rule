import { createHash } from 'node:crypto';
import path from 'node:path';
import { DSH_TIMEOUT_MS } from '../task-lifecycle.mjs';
import {
  DispatchPolicyError, DispatchSource, LUNA_MODEL, LUNA_REASONING_EFFORT, TERRA_MODEL, TERRA_REASONING_EFFORT
} from './policy.mjs';

const SCOPE_FIELDS = ['cwd', 'permissionMode', 'capability', 'writeScopes', 'writes', 'commands',
  'authorizationNote', 'constraints', 'limits', 'timeoutMs', 'deadline', 'idempotencyKey',
  'acceptAntigravityUsage', 'antigravityModel'];
const PEERS = Object.freeze({
  terra: { model: TERRA_MODEL, reasoning_effort: TERRA_REASONING_EFFORT },
  luna: { model: LUNA_MODEL, reasoning_effort: LUNA_REASONING_EFFORT }
});
const NATIVE_PEERS = new Set([...Object.keys(PEERS), 'antigravity']);
const REQUEST_FIELDS = ['peer', 'goal', 'acceptance', 'contextSummary', 'idempotencyKey'];
const KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const ID = /^[A-Za-z0-9_.:@/-]{1,160}$/;
const ANTIGRAVITY_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ANTIGRAVITY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const WRITE_FIELDS = ['writeScopes', 'writes', 'commands'];
const STATES = ['completed', 'finished', 'running', 'blocked', 'failed', 'timed_out', 'cancelled', 'unknown', 'unknown_after_disconnect'];
const UNCONFIRMED = ['running', 'timed_out', 'unknown', 'unknown_after_disconnect'];

function freezeScope(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const member of Object.values(value)) freezeScope(member);
  return value;
}

function parentScope(input) {
  const { task, permissionMode } = input;
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  if (permissionMode !== undefined && task.permissionMode !== undefined && permissionMode !== task.permissionMode) return null;
  try {
    const scope = structuredClone(Object.fromEntries(SCOPE_FIELDS.filter(key => Object.hasOwn(task, key)).map(key => [key, task[key]])));
    scope.permissionMode = task.permissionMode ?? permissionMode;
    if (typeof scope.cwd !== 'string' || (!path.isAbsolute(scope.cwd) && !path.win32.isAbsolute(scope.cwd))
      || typeof scope.idempotencyKey !== 'string' || !KEY.test(scope.idempotencyKey)
      || !['read-only', 'workspace-write'].includes(scope.permissionMode)) return null;
    if (WRITE_FIELDS.some(key => scope[key] !== undefined && !Array.isArray(scope[key]))
      || (scope.permissionMode === 'read-only'
        && (scope.capability === 'workspace-write' || WRITE_FIELDS.some(key => scope[key]?.length)))) return null;
    scope.timeoutMs ??= DSH_TIMEOUT_MS.default;
    if (!Number.isSafeInteger(scope.timeoutMs) || scope.timeoutMs < 1 || scope.timeoutMs > DSH_TIMEOUT_MS.maximum
      || (scope.deadline !== undefined && !Number.isSafeInteger(scope.deadline))) return null;
    scope.deadline = Math.min(scope.deadline ?? Infinity, Date.now() + scope.timeoutMs);
    return freezeScope(scope);
  } catch {
    return null; // Invalid peer scope must not change an unrelated general route.
  }
}

function peerRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !REQUEST_FIELDS.includes(key))
    || typeof request.peer !== 'string' || !NATIVE_PEERS.has(request.peer)
    || typeof request.idempotencyKey !== 'string' || !KEY.test(request.idempotencyKey)) {
    throw new DispatchPolicyError('DISPATCH_NATIVE_PEER_REQUEST', 'Use a peer, a stable key, a goal, acceptance criteria, and optional context.');
  }
  const { peer, idempotencyKey, goal, acceptance, contextSummary = '' } = request;
  for (const [value, bytes, required] of [[goal, 12000, true], [acceptance, 8000, true], [contextSummary, 16000, false]]) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > bytes || (required && !value.trim())) {
      throw new DispatchPolicyError('DISPATCH_NATIVE_PEER_REQUEST', 'Supply bounded peer goal, acceptance and context text.');
    }
  }
  return { peer, idempotencyKey, goal, acceptance, contextSummary };
}

async function runPeer({ request, scope, adapter, signal, idempotencyKey }) {
  const { peer, goal, acceptance, contextSummary } = request;
  const antigravity = peer === 'antigravity';
  const alias = antigravity ? scope.antigravityModel : null;
  const route = antigravity ? { model: alias } : PEERS[peer];
  const identity = antigravity ? {
    peer, source: DispatchSource.SUBSCRIPTION, coordinator_mode: DispatchSource.SUBSCRIPTION,
    idempotency_key: idempotencyKey, parent_idempotency_key: scope.idempotencyKey,
    antigravity: { model_alias: alias }
  } : {
    peer, source: DispatchSource.SUBSCRIPTION, idempotency_key: idempotencyKey,
    parent_idempotency_key: scope.idempotencyKey, requested_model: route.model, requested_reasoning_effort: route.reasoning_effort
  };
  const refusal = (status, error_code) => freezeScope({ ...identity, status, error_code });
  if (antigravity && scope.acceptAntigravityUsage !== true) {
    return refusal('blocked', 'DISPATCH_NATIVE_PEER_ANTIGRAVITY_CONSENT_REQUIRED');
  }
  if (antigravity && (typeof alias !== 'string' || !ANTIGRAVITY_ALIAS.test(alias))) {
    return refusal('blocked', 'DISPATCH_NATIVE_PEER_ANTIGRAVITY_MODEL_UNAPPROVED');
  }
  const constraints = scope.constraints ?? '';
  if (antigravity && (typeof constraints !== 'string' || Buffer.byteLength(constraints) > 12000)) {
    return refusal('blocked', 'DISPATCH_NATIVE_PEER_ANTIGRAVITY_LIMIT');
  }
  if (typeof adapter?.dispatch !== 'function') return refusal('blocked', 'DISPATCH_NATIVE_PEER_MISSING');
  if (signal.aborted) return refusal('cancelled', 'DISPATCH_NATIVE_PEER_STOPPED');
  const timeoutMs = scope.deadline - Date.now();
  if (timeoutMs <= 0) return refusal('blocked', 'DISPATCH_NATIVE_PEER_DEADLINE');
  const childSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const peerScope = Object.fromEntries(Object.entries(scope)
    .filter(([key]) => !['acceptAntigravityUsage', 'antigravityModel'].includes(key)));
  const task = freezeScope({ ...peerScope, parentIdempotencyKey: scope.idempotencyKey, idempotencyKey, timeoutMs });
  const stopped = Promise.withResolvers();
  const onAbort = () => stopped.resolve(null);
  childSignal.addEventListener('abort', onAbort, { once: true });
  let result;
  try {
    const prompt = antigravity
      ? [goal, constraints ? `Constraints:\n${constraints}` : '',
        contextSummary ? `Supplied material:\n${contextSummary}` : '', `Acceptance criteria:\n${acceptance}`]
        .filter(Boolean).join('\n\n')
      : [goal, acceptance, contextSummary].filter(Boolean).join('\n\n');
    const payload = antigravity
      ? {
        request: freezeScope({
          peer, source: DispatchSource.SUBSCRIPTION, coordinatorMode: DispatchSource.SUBSCRIPTION,
          purpose: 'writing', acceptAntigravityUsage: true, modelAlias: alias,
          idempotencyKey, goal, acceptance, contextSummary, constraints, prompt
        }),
        // The cwd stays in host-side authorization metadata for local path
        // checks. It is not included in the text request sent to the model.
        authorization: freezeScope({
          cwd: scope.cwd, parentIdempotencyKey: scope.idempotencyKey, idempotencyKey,
          deadline: scope.deadline, timeoutMs
        }),
        signal: childSignal
      }
      : {
        ...route, peer, source: DispatchSource.SUBSCRIPTION, purpose: 'general', prompt,
        goal, acceptance, contextSummary, required_capabilities: [], task, signal: childSignal
      };
    result = await Promise.race([
      adapter.dispatch(payload),
      stopped.promise
    ]);
  } catch {
    return refusal('unknown', 'DISPATCH_NATIVE_PEER_OUTCOME_UNKNOWN');
  } finally {
    childSignal.removeEventListener('abort', onAbort);
  }
  if (childSignal.aborted || !result || !STATES.includes(result.status)) {
    return refusal('unknown', 'DISPATCH_NATIVE_PEER_OUTCOME_UNKNOWN');
  }
  let receipt;
  try {
    const merged = { ...result, ...identity };
    if (antigravity) merged.antigravity = { ...(result.antigravity ?? {}), ...identity.antigravity };
    receipt = structuredClone(merged);
  }
  catch { return refusal('unknown', 'DISPATCH_NATIVE_PEER_OUTCOME_UNKNOWN'); }
  if (['completed', 'finished'].includes(result.status)) {
    const taskId = result.task_id ?? result.agent_id;
    if (antigravity) {
      const evidence = result.antigravity;
      const wrongAlias = evidence?.model_alias !== undefined && evidence.model_alias !== alias;
      if (wrongAlias || typeof evidence?.requested_model !== 'string' || !ANTIGRAVITY_MODEL.test(evidence.requested_model)
        || (evidence.cli_selected_model !== undefined && (typeof evidence.cli_selected_model !== 'string'
          || !ANTIGRAVITY_MODEL.test(evidence.cli_selected_model)))
        || (result.source !== undefined && result.source !== DispatchSource.SUBSCRIPTION)
        || typeof taskId !== 'string' || !ID.test(taskId)) {
        return freezeScope({ ...receipt, status: 'blocked', error_code: 'DISPATCH_NATIVE_PEER_EVIDENCE' });
      }
      receipt.antigravity = freezeScope({ ...evidence, model_alias: alias, provider_model: 'unverified' });
    } else if (result.model !== route.model || result.reasoning_effort !== route.reasoning_effort
      || (result.source !== undefined && result.source !== DispatchSource.SUBSCRIPTION)
      || typeof taskId !== 'string' || !ID.test(taskId)) {
      return freezeScope({ ...receipt, status: 'blocked', error_code: 'DISPATCH_NATIVE_PEER_EVIDENCE' });
    }
  }
  return freezeScope(receipt);
}

export function nativePeerCoordinator(input, { nativeTerra, nativeLuna, nativeAntigravity, signal }) {
  const scope = parentScope(input);
  const active = new AbortController();
  const ownerSignal = signal ? AbortSignal.any([signal, active.signal]) : active.signal;
  const requests = new Map();
  let accepting = true;
  let writerSettled = Promise.resolve();
  let writerUnconfirmed = false;
  return {
    delegate(value) {
      if (!accepting) throw new DispatchPolicyError('DISPATCH_NATIVE_PEER_CLOSED', 'The original Sol coordinator has already returned.');
      if (!scope) throw new DispatchPolicyError('DISPATCH_NATIVE_PEER_SCOPE', 'The native peer requires a verified parent cwd, permission mode, key and task budget.');
      const request = peerRequest(value);
      const fingerprint = JSON.stringify(request);
      const prior = requests.get(request.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new DispatchPolicyError('DISPATCH_NATIVE_PEER_KEY_REUSED', 'The peer key already belongs to different work.');
        }
        return prior.result;
      }
      const idempotencyKey = 'peer-' + createHash('sha256')
        .update(JSON.stringify([scope.cwd, scope.idempotencyKey, request.idempotencyKey])).digest('hex');
      const adapter = request.peer === 'terra' ? nativeTerra : request.peer === 'luna' ? nativeLuna : nativeAntigravity;
      const invoke = () => runPeer({ request, scope, adapter, signal: ownerSignal, idempotencyKey });
      let result;
      if (scope.permissionMode === 'workspace-write') {
        // All peers inherit the same write scope. Queue them in this
        // coordinator until the prior result is known; readers can overlap.
        result = writerSettled.then(() => writerUnconfirmed
          ? Object.freeze({ peer: request.peer, idempotency_key: idempotencyKey, status: 'blocked',
            error_code: 'DISPATCH_NATIVE_PEER_PREDECESSOR_UNCONFIRMED' })
          : invoke());
        writerSettled = result.then(receipt => {
          writerUnconfirmed ||= UNCONFIRMED.includes(receipt.status) || receipt.error_code === 'DISPATCH_NATIVE_PEER_EVIDENCE';
        });
      } else result = Promise.resolve().then(invoke);
      requests.set(request.idempotencyKey, { fingerprint, result });
      return result;
    },
    collect() {
      accepting = false;
      return Promise.all([...requests.values()].map(entry => entry.result));
    },
    close() {
      accepting = false;
      active.abort();
    }
  };
}
