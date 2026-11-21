import { execFile } from 'node:child_process';
import path from 'node:path';

// Deployment installs the helper here with an administrator-owned ACL. There
// is no executable, URL, credential, or command override in MCP task input.
export function brokerCall(envelope, signal) {
  const programs = process.env.ProgramW6432 || process.env.ProgramFiles;
  if (process.platform !== 'win32' || !programs || !path.isAbsolute(programs)) {
    return Promise.reject(Error('Windows credential broker unavailable.'));
  }
  const executable = path.join(programs, 'AiRuleSolBroker', 'SolBroker.exe');
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => /^(SystemRoot|WINDIR|SystemDrive)$/i.test(name)));
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['client'], {
      cwd: path.dirname(executable), env, windowsHide: true, shell: false, signal,
      encoding: 'utf8', maxBuffer: 2 * 1024 * 1024
    }, (error, stdout) => {
      // Never propagate raw stdout, stderr, command diagnostics or foreign fields.
      if (error) return reject(Error('Credential broker connection failed.'));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(Error('Invalid credential broker response.')); }
    });
    child.stdin.on('error', () => {}); // Completion is reported by execFile.
    child.stdin.end(JSON.stringify(envelope));
  });
}
