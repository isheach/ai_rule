import { startSolServer } from '../bridges/sol/server.mjs';

if (!process.send) throw Error('Fixture broker requires a private parent IPC channel.');
const clock = process.env.SOL_TEST_CLOCK;
let next = 0;
startSolServer({
  configPath: process.argv[2],
  ...(process.env.SOL_TEST_ENTRY_CALLER ? { identifyEntryCaller: () => process.env.SOL_TEST_ENTRY_CALLER } : {}),
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
