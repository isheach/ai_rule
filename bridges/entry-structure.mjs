export const EntryStructure = Object.freeze({ ASTRA: 'astra', SOL: 'sol' });
export const ENTRY_STRUCTURES = Object.freeze(Object.values(EntryStructure));

export function normalizeEntryStructure(value = EntryStructure.ASTRA) {
  if (ENTRY_STRUCTURES.includes(value)) return value;
  const error = Error('entryStructure must be astra or sol.');
  error.code = 'DISPATCH_ENTRY_STRUCTURE_INVALID';
  throw error;
}

export function codexEntryCaller(context, observedRole) {
  if (!context) return { role: 'unverified', evidence_source: null };
  const role = ['user', 'host', 'astra', 'sol'].includes(observedRole) ? observedRole : 'unverified';
  return {
    role,
    evidence_source: 'verified_codex_context',
    thread_id: context.childId,
    thread_kind: context.childId === context.rootId ? 'root' : 'child',
    ...(role === 'unverified' ? {} : { role_source: 'host_adapter' })
  };
}
