import fs from 'node:fs';

// DeepSeek V4.1 Flash on OpenCode Go: weekdays 01:00-04:00 and 06:00-10:00 UTC.
// Local display here is fixed UTC+8 (China / Singapore, no daylight saving).
const OFFSET=8*60*60*1000;
const MINUTE=60000;
const WEEKDAY=new Set([1,2,3,4,5]);
export const OFFPEAK_DEFAULT=Object.freeze({
  enabled:true,timezone:'Asia/Shanghai',
  weekdayPeakWindows:['09:00-12:00','14:00-18:00'],
  stopNewTasksBeforePeakMinutes:10,
  checkpointNoticeMinutes:5,
  rejectTaskIfBudgetExceedsWindow:true,
  hardStopAtPeak:true,
  resumeAutomatically:false
});
const parseTime=s=>{
  if(typeof s!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s))throw Error('Invalid HH:MM: '+String(s));
  const [h,m]=s.split(':').map(Number);return 60*h+m;
};
export function validateSchedule(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Schedule must be a JSON object.');
  for(const key of Object.keys(input))if(!Object.hasOwn(OFFPEAK_DEFAULT,key))throw Error('Unknown schedule field: '+key);
  const c={...OFFPEAK_DEFAULT,...input};
  if(c.enabled!==true)throw Error('Explicit schedule must be enabled; omit --schedule-config to disable.');
  if(!['Asia/Shanghai','Asia/Singapore'].includes(c.timezone))throw Error('Only UTC+8 China/Singapore is supported.');
  if(c.hardStopAtPeak!==true||c.resumeAutomatically!==false)throw Error('Only hard-stop with no automatic resume is supported.');
  if(typeof c.rejectTaskIfBudgetExceedsWindow!=='boolean')throw Error('Invalid rejectTaskIfBudgetExceedsWindow.');
  for(const field of ['stopNewTasksBeforePeakMinutes','checkpointNoticeMinutes'])
    if(!Number.isInteger(c[field])||c[field]<0||c[field]>120)throw Error(field+' must be 0..120 minutes.');
  if(!Array.isArray(c.weekdayPeakWindows)||c.weekdayPeakWindows.length<1||c.weekdayPeakWindows.length>8)throw Error('Need 1..8 weekday peak windows.');
  const windows=c.weekdayPeakWindows.map(s=>{
    if(typeof s!=='string'||!/^\d\d:\d\d-\d\d:\d\d$/.test(s))throw Error('Use HH:MM-HH:MM ranges.');
    const [start,end]=s.split('-').map(parseTime);
    if(end<=start)throw Error('Peak windows must be same-day and nonempty.');
    return {start,end};
  }).sort((a,b)=>a.start-b.start);
  for(let i=1;i<windows.length;i++)if(windows[i].start<windows[i-1].end)throw Error('Overlapping windows.');
  if(c.stopNewTasksBeforePeakMinutes>windows[0].start)throw Error('Prepeak gate would cross midnight.');
  return Object.freeze({...c,windows});
}
export function loadSchedule(filename){
  if(!filename)return null; // Existing MCP registrations remain unscheduled.
  return validateSchedule(JSON.parse(fs.readFileSync(filename,'utf8')));
}
export function scheduleSnapshot(config,date=new Date()){
  const t=(date instanceof Date?date:new Date(date)).getTime();
  if(!Number.isFinite(t))throw Error('Invalid schedule time.');
  if(!config)return {enabled:false,phase:'unrestricted',accept_new_tasks:true,timezone:null,next_peak_at:null,next_offpeak_at:null,hard_stop_at:null,stop_new_at:null,resume_automatically:false};
  const local=new Date(t+OFFSET);
  const midnight=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-OFFSET;
  const windows=[];
  for(let day=-1;day<=8;day++){
    const base=midnight+day*86400000;
    if(!WEEKDAY.has(new Date(base+OFFSET).getUTCDay()))continue;
    for(const w of config.windows)windows.push({start:base+w.start*MINUTE,end:base+w.end*MINUTE});
  }
  const active=windows.find(w=>w.start<=t&&t<w.end);
  const next=windows.filter(w=>w.start>t).sort((a,b)=>a.start-b.start)[0];
  if(!active&&!next)throw Error('Cannot determine next peak boundary.');
  const gate=next?next.start-config.stopNewTasksBeforePeakMinutes*MINUTE:null;
  const phase=active?'peak':gate!==null&&gate<=t?'prepeak':'offpeak';
  return {
    enabled:true,phase,timezone:config.timezone,accept_new_tasks:phase==='offpeak',
    next_peak_at:next?new Date(next.start).toISOString():null,
    next_offpeak_at:active?new Date(active.end).toISOString():phase==='prepeak'&&next?new Date(next.end).toISOString():null,
    stop_new_at:next?new Date(gate).toISOString():null,
    hard_stop_at:active?new Date(active.start).toISOString():next?new Date(next.start).toISOString():null,
    checkpoint_due_at:!active&&next?new Date(next.start-config.checkpointNoticeMinutes*MINUTE).toISOString():null,
    reject_if_budget_exceeds_window:config.rejectTaskIfBudgetExceedsWindow,
    resume_automatically:false
  };
}
export function scheduleTaskPreamble(snapshot){
  if(!snapshot.enabled||!snapshot.hard_stop_at)return '';
  const checkpoint=snapshot.checkpoint_due_at||snapshot.hard_stop_at;
  return '[Offpeak schedule: local bridge will terminate its own DSH process at '+snapshot.hard_stop_at+' UTC. Aim to save partial progress and a handoff before '+checkpoint+' UTC if possible; avoid risky writes near cutoff. This is an advance notice, NOT a guaranteed or atomic checkpoint. It grants no write, install or Git permissions. Automatic resume is disabled.]\n\n';
}
