export const DSH_TIMEOUT_MS = Object.freeze({ type: 'integer', minimum: 1000, maximum: 3600000, default: 900000 });
export const HY4_ACP_TIMEOUT_MS = Object.freeze({ type: 'integer', minimum: 1000, maximum: 900000, default: 600000 });
export const WAIT_MS = Object.freeze({ type: 'integer', minimum: 0, maximum: 60000, default: 25000 });

export function validateWaitMs(value) {
  if (!Number.isInteger(value) || value < WAIT_MS.minimum || value > WAIT_MS.maximum) {
    throw Error(`waitMs must be ${WAIT_MS.minimum}..${WAIT_MS.maximum}.`);
  }
}

export function preferRun(startTool, waitTool) {
  return 'Prefer for bounded tasks when the effective host tool timeout covers the task budget plus startup and cleanup, '
    + `and no early task ID or mid-task intervention is needed. Otherwise use ${startTool} and ${waitTool}.`;
}

export const waitForExisting =
  `Pass waitMs=${WAIT_MS.maximum} when the host timeout allows. If still running and no decision is needed, wait again with the original handle.`;
