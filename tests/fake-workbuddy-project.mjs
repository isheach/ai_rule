import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startWorkBuddyProjectServer } from '../bridges/workbuddy/project-server.mjs';

const dsf = 'deepseek-v4-flash';

export function fakeProjectSdk({ model = dsf, onPrompt = () => {} } = {}) {
  function session(options, sessionId = randomUUID()) {
    let prompt;
    return {
      sessionId,
      async connect() {},
      async getAvailableModels() { return [{ modelId: model }]; },
      async setModel(actual) { if (actual !== model) throw Error('Unexpected model.'); },
      async send(value) {
        const instructions = value.match(/\nCoordinator instructions:\n([^\n]+)/)?.[1];
        prompt = JSON.parse(instructions ?? value);
        onPrompt(prompt);
      },
      close() {},
      async *stream() {
        yield { type: 'system', subtype: 'init', model, session_id: sessionId, permissionMode: 'default' };
        if (prompt.disconnect) return;
        const content = [];
        let denied = false;
        async function tool(name, input, operation) {
          const id = randomUUID();
          content.push({ type: 'tool_use', id, name, input });
          const envelope = { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id,
            session_id: sessionId, cwd: options.cwd };
          const result = await options.hooks.PreToolUse[0].hooks[0](envelope, id);
          if (result.decision === 'block') { denied = true; return ''; }
          return operation();
        }
        const read = file => tool('Read', { file_path: file }, () => fs.readFileSync(path.resolve(options.cwd, file), 'utf8'));
        const script = prompt.script ? await read(prompt.script) : '';
        const data = prompt.data ? await read(prompt.data) : '';
        const answer = prompt.paper + ': ' + script + ' / ' + data;
        if (prompt.output) {
          await tool('Write', { file_path: prompt.output, content: answer },
            () => fs.writeFileSync(path.resolve(options.cwd, prompt.output), answer));
        }
        yield { type: 'assistant', session_id: sessionId, message: { model, content } };
        yield { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: answer,
          permission_denials: denied ? [{}] : [] };
      }
    };
  }
  return { createSession: options => session(options), resumeSession: (id, options) => session(options, id) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startWorkBuddyProjectServer({ configPath: process.argv[2], sdk: fakeProjectSdk() });
}
