import { digest } from './journal.mjs';

// The original validated handoff still supplies the journal fingerprint and
// the pre-existing Terra adapter input. This is the internal Sol task shape.
export function taskContract(handoff) {
  const { goal, cwd, permissionMode, capability, authorizationNote, constraints, acceptance, writeScopes, writes, commands } = handoff;
  return {
    goal,
    scope: { cwd, permissionMode, capability },
    authorization: { note: authorizationNote, writeScopes, writes, commands },
    constraints,
    acceptance,
    evidence: {
      request: 'Report the relevant changes, checks and outcomes with evidence references and unresolved checks.',
      authority: 'Host records establish mechanical facts. Label claims made only in executor text as reported.'
    }
  };
}

export function contractSummary(contract) {
  const { goal, scope, authorization, constraints, acceptance } = contract;
  return {
    goal_sha256: digest(goal),
    scope: { permission_mode: scope.permissionMode, capability: scope.capability },
    authorization: {
      note_supplied: Boolean(authorization.note), exact_write_count: authorization.writes.length,
      write_scope_count: authorization.writeScopes.length, command_count: authorization.commands.length
    },
    constraints_sha256: constraints ? digest(constraints) : null,
    acceptance_sha256: digest(acceptance),
    evidence_policy: 'host_mechanical_sol_semantic'
  };
}

export function executorPrompt(contract, instructions) {
  const { goal, scope, authorization, constraints, acceptance, evidence } = contract;
  const { note, writes, writeScopes, commands } = authorization;
  const explicit = writes.length || writeScopes.length || commands.length
    ? `Explicit task authorization:\n${JSON.stringify({ writes, writeScopes, commands })}` : '';
  return [
    `Original goal:\n${goal}`,
    ['Authorization and constraints:', note, constraints, `Use only ${scope.cwd} under ${scope.permissionMode} permission.`, explicit].filter(Boolean).join('\n'),
    `Acceptance criteria:\n${acceptance}`,
    `Coordinator instructions:\n${instructions}`,
    evidence.request
  ].join('\n\n');
}
