import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFPEAK_DEFAULT,validateSchedule,scheduleSnapshot,scheduleTaskPreamble,loadSchedule } from '../bridges/dsh/schedule.mjs';
import { TaskManager } from '../bridges/dsh/core.mjs';
import { RootPool } from '../bridges/pool/core.mjs';
const cfg=validateSchedule(OFFPEAK_DEFAULT);
const at=s=>scheduleSnapshot(cfg,new Date(s));
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'ai-rule-schedule-'));
const mock=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'mock-dsh.mjs');
const cli={command:process.execPath,prefix:[mock]};

test('a persisted root toggle updates running workers and leaves another root on its own calendar', async () => {
  const rootA = '00000000-0000-4000-8000-000000000001';
  const rootB = '00000000-0000-4000-8000-000000000002';
  const pool = new RootPool({ root: temp() });
  const otherConnection = new RootPool({ root: pool.root });
  let instant = '2026-11-09T00:30:00Z';
  const worker = rootId => new TaskManager({
    cli, runtime: temp(), check: () => ({}), schedule: cfg, scheduleTickMs: 15,
    scheduleEnabledForRoot: () => pool.scheduleEnabled(rootId), clock: () => new Date(instant)
  });
  const [a, b] = [worker(rootA), worker(rootB)];
  const cwd = temp();
  assert.equal(pool.scheduleEnabled(rootA), false);
  assert.equal(pool.scheduleEnabled(rootB), false);
  pool.setSchedule(rootA, true);
  pool.setSchedule(rootB, true);
  try {
    const stay = await a.start({ cwd, prompt: 'sleep:850', idempotencyKey: 'stay', timeoutMs: 5000 });
    const stop = await b.start({ cwd, prompt: 'hang', idempotencyKey: 'stop', timeoutMs: 5000 });
    otherConnection.setSchedule(rootA, false);
    instant = '2026-11-09T01:00:01Z';
    assert.equal((await b.wait(stop.task_id, 3000)).status, 'schedule_stopped');
    assert.equal((await a.wait(stay.task_id, 3000)).status, 'completed');
    assert.equal(otherConnection.scheduleEnabled(rootB), true);
    const alreadyRunning = await a.start({ cwd, prompt: 'hang', idempotencyKey: 'already-running', timeoutMs: 5000 });
    otherConnection.setSchedule(rootA, true);
    assert.equal((await a.wait(alreadyRunning.task_id, 3000)).status, 'schedule_stopped');
    pool.setSchedule(rootA, false);
    assert.equal(a.get(alreadyRunning.task_id).status, 'schedule_stopped');
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('weekdays UTC+8 peak boundary and 10-minute gate',()=>{
  assert.equal(at('2026-11-09T00:49:59Z').phase,'offpeak');
  assert.equal(at('2026-11-09T00:50:00Z').phase,'prepeak');
  assert.equal(at('2026-11-09T01:00:00Z').phase,'peak');
  assert.equal(at('2026-11-09T03:59:59Z').phase,'peak');
  assert.equal(at('2026-11-09T04:00:00Z').phase,'offpeak');
  assert.equal(at('2026-11-09T05:50:00Z').phase,'prepeak');
  assert.equal(at('2026-11-09T06:00:00Z').phase,'peak');
  assert.equal(at('2026-11-09T10:00:00Z').phase,'offpeak');
});
test('weekend allowed and following Monday computed',()=>{
  assert.equal(at('2026-11-07T02:00:00Z').phase,'offpeak');
  assert.equal(at('2026-11-08T07:00:00Z').phase,'offpeak');
  assert.equal(at('2026-11-06T10:00:00Z').next_peak_at,'2026-11-09T01:00:00.000Z');
});
test('unscheduled bridge preserves previous behavior',()=>{
  assert.equal(scheduleSnapshot(null).accept_new_tasks,true);
  assert.equal(scheduleSnapshot(null).phase,'unrestricted');
});
test('wrong schedule settings fail closed',()=>{
  for(const change of [{timezone:'America/New_York'},{hardStopAtPeak:false},{resumeAutomatically:true},{weekdayPeakWindows:['12:00-09:00']},{weekdayPeakWindows:['09:00-12:00','11:00-13:00']},{stopNewTasksBeforePeakMinutes:121}])
    assert.throws(()=>validateSchedule({...OFFPEAK_DEFAULT,...change}));
  const file=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../config/offpeak.schedule.json');
  assert.equal(loadSchedule(file).windows.length,2);
});
test('advance notice cannot grant writes or promise atomic checkpoints',()=>{
  const note=scheduleTaskPreamble(at('2026-11-09T00:40:00Z'));
  assert.match(note,/NOT a guaranteed or atomic checkpoint/);
  assert.match(note,/grants no write/);
});
test('manager blocks peak tasks and over-budget tasks before spawn',async()=>{
  const runtime=temp(),cwd=temp();
  const task={cwd,prompt:'ok',idempotencyKey:'peak-block',timeoutMs:1000};
  const peak=new TaskManager({cli,runtime,schedule:cfg,clock:()=>new Date('2026-11-09T01:30:00Z')});
  await assert.rejects(peak.start(task),/schedule|peak/i);
  assert.equal(fs.existsSync(path.join(runtime,'active.lock')),false);
  const budget=new TaskManager({cli,runtime,schedule:cfg,clock:()=>new Date('2026-11-09T00:47:00Z')});
  await assert.rejects(budget.start({...task,timeoutMs:720000,idempotencyKey:'budget-block'}),/budget|window/i);
});
test('owned process is stopped at scheduled boundary without auto resume',async()=>{
  const runtime=temp(),cwd=temp();
  const begin=Date.now(),base=Date.parse('2026-11-09T00:00:00Z');
  const clock=()=>new Date(base+(Date.now()-begin)*300000);
  const manager=new TaskManager({cli,runtime,schedule:cfg,clock,scheduleTickMs:5});
  const first=await manager.start({cwd,prompt:'hang',idempotencyKey:'peak-stop',timeoutMs:10000});
  const finished=await manager.wait(first.task_id,4000);
  assert.equal(finished.status,'schedule_stopped');
  assert.equal(finished.stop_reason,'scheduled_peak');
  assert.equal(fs.existsSync(path.join(runtime,'active.lock')),false);
});
