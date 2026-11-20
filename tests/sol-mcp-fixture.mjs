import { startSolServer } from '../bridges/sol/server.mjs';

const origin = process.env.SOL_TEST_RESPONSES_ORIGIN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')) throw Error('Sol fixture requires its own local Responses server.');
const clock = process.env.SOL_TEST_CLOCK;
startSolServer({
  configPath: process.argv[2],
  fetchImpl(url, options) {
    if (url !== 'https://api.openai.com/v1/responses' || options.redirect !== 'error') throw Error('Unexpected production API destination.');
    return fetch(`${origin}/v1/responses`, options);
  },
  ...(clock ? { clock: () => new Date(clock) } : {})
});
