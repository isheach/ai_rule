// Loaded only by the real legacy stdio test process, before the server starts.
const SystemDate = Date;
const instant = SystemDate.parse(process.env.AI_RULE_FIXTURE_CLOCK);
if (!Number.isFinite(instant)) throw Error('Missing DSH fixture clock.');
globalThis.Date = class extends SystemDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
};
