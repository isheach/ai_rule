import { startSolServer } from '../bridges/sol/server.mjs';
import fs from 'node:fs';
import path from 'node:path';

if (!process.send) throw Error('Fixture broker requires a private parent IPC channel.');
const clock = process.env.SOL_TEST_CLOCK;
let next = 0;
startSolServer({
  configPath: process.argv[2],
  ...(process.env.SOL_TEST_ENTRY_CALLER ? { identifyEntryCaller: () => process.env.SOL_TEST_ENTRY_CALLER } : {}),
  ...(process.env.SOL_TEST_HOST_CHECKS === '1' ? { dispatch: {
    verifyExecutorReceipt({ contract, receipt }) {
      if (Object.hasOwn(receipt, 'answer')) throw Error('Executor text cannot select a fixture verification action.');
      const expectedFile = path.join(contract.scope.cwd, 'public-control.txt');
      if (!contract.authorization.writes.some(write => write.path === expectedFile)) throw Error('Unexpected fixture scope.');
      return [{ id: 'file-content', status: fs.readFileSync(expectedFile, 'utf8') === 'verified' ? 'passed' : 'failed' }];
    }
  } } : {}),
  async callBroker(envelope, signal) {
    if (process.env.SOL_TEST_BROKER_UNAVAILABLE) throw Error('Fixture broker unavailable.');
    signal.throwIfAborted();
    const id = ++next;
    return new Promise((resolve, reject) => {
      const closed = () => { cleanup(); reject(Error('Fixture IPC interrupted.')); };
      const receive = message => {
        if (message.id !== id) return;
        cleanup();
        resolve(message.reply);
      };
      const cleanup = () => {
        process.off('message', receive);
        signal.removeEventListener('abort', closed);
      };
      process.on('message', receive);
      signal.addEventListener('abort', closed, { once: true });
      process.send({ id, envelope });
    });
  },
  ...(clock ? { clock: () => new Date(clock) } : {})
});
