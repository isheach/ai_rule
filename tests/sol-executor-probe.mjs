import fs from 'node:fs';
import path from 'node:path';

// Run inside the disposable DSF worker. Report only booleans. The canary's
// value lives in the parent-side fixture broker and is never given to the worker.
export function executorProbe(cwd, task) {
  const control = path.join(cwd, 'public-control.txt');
  if (!fs.existsSync(control) || fs.readFileSync(control, 'utf8') !== 'sol-offline-workspace') return {};
  const marker = /sk-offlineSolBroker[0-9a-f]{32}/;
  const files = fs.readdirSync(cwd, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  return {
    readWorkspace: true,
    environmentLeak: Object.values(process.env).some(value => marker.test(value)),
    workspaceLeak: files.some(entry => marker.test(fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))),
    taskLeak: marker.test(JSON.stringify(task))
  };
}
