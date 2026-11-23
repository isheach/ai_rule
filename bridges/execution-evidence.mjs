// These are observations at the bridge boundary. Executor text and configured
// model names do not establish a check, a file change or a returned model.
export function poolExecutionEvidence(result, scope) {
  const receipt = result.receipt;
  const matched = result.admission_state === 'accepted' && Boolean(result.task_id)
    && receipt?.task_id === result.task_id;
  const checks = matched ? { task_identity: 'passed' } : {};
  if (receipt && result.task_id && receipt.task_id !== result.task_id) checks.task_identity = 'failed';
  if (matched && ['dsh', 'hy4'].includes(result.backend)) {
    if (scope) {
      checks.working_directory = receipt.cwd === scope.cwd ? 'passed' : 'failed';
      checks.permission_mode = (receipt.task_permission_mode ?? receipt.permission_mode) === scope.permissionMode ? 'passed' : 'failed';
    }
    if (result.status === 'completed') {
      const completed = result.backend === 'dsh'
        ? receipt.exit_code === 0 && (receipt.final_reason?.kind ?? receipt.final_reason) === 'completed'
        : receipt.stop_reason === 'end_turn';
      checks.process_completion = receipt.status === 'completed' && completed ? 'passed' : 'failed';
    }
  }
  const observed = result.backend === 'dsh'
    ? Number.isInteger(receipt?.exit_code) || receipt?.pid > 0
    : receipt?.stop_reason === 'end_turn' || Boolean(receipt?.returned_model);
  const output = {
    source: matched ? 'root_pool_executor_receipt' : null,
    actually_executed: matched && observed ? 'observed' : 'unverified',
    returned_model: matched ? receipt.actual_route?.model ?? receipt.returned_model ?? null : null,
    checks
  };
  if (result.backend === 'dsh') {
    output.workspace_changes = 'unverified';
    output.command_results = 'unverified';
  }
  return output;
}

export function mechanicalVerdict(receipt) {
  const evidence = receipt?.execution_evidence;
  const host = receipt?.host_verification?.status;
  if (host === 'failed' || Object.values(evidence?.checks ?? {}).includes('failed')) return 'failed';
  if (host === 'unverified') return 'unverified';
  if (receipt?.status === 'completed' && receipt.task_id && evidence?.actually_executed === 'observed'
    && (!['dsh', 'hy4'].includes(receipt.backend) || evidence.checks.process_completion === 'passed')) return 'passed';
  return 'unverified';
}

export function coordinationRouteEvidence(record) {
  const responses = record.responses.filter(response => response.response_id && !response.repeated_response_id).map(response => ({
    response_id: response.response_id, request_id: response.request_id ?? null,
    returned_model: response.returned_model ?? null, reasoning_effort: response.reasoning_effort ?? null
  }));
  const executors = record.steps.map(step => ({
    downstream_idempotency_key: step.downstream_idempotency_key ?? null,
    task_id: step.receipt?.task_id ?? step.executed_via?.task_id ?? null,
    session_id: step.receipt?.session_id ?? null,
    instance: step.receipt?.instance ?? null,
    dispatch_id: step.receipt?.dispatch_id ?? step.dispatch_id ?? null,
    ...(step.receipt?.response_ids ? { response_ids: step.receipt.response_ids } : {}),
    backend: step.receipt?.backend ?? step.executed_via?.backend ?? null,
    returned_model: step.receipt?.returned_model ?? step.receipt?.execution_evidence?.returned_model ?? null,
    actually_executed: step.receipt?.execution_evidence?.actually_executed ?? 'unverified',
    evidence_source: step.receipt?.execution_evidence?.source ?? null,
    status: step.receipt?.status ?? null
  }));
  return {
    coordination_id: record.task_id,
    coordinator: record.requested_backend === 'Terra' ? null
      : { actually_executed: responses.length ? 'observed' : 'unverified',
        evidence_source: responses.length ? 'protected_broker_response' : null, responses },
    executors,
    ...(record.peer_results?.length ? { collaborators: record.peer_results.map(coordinationRouteEvidence) } : {})
  };
}
