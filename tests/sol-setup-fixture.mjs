import fs from 'node:fs';
import { prepareElevation, verifyCheckout } from '../scripts/sol-setup.mjs';

const [repository, git, revision, bundlePath, clientSid, action = 'Install'] = process.argv.slice(2);
const { sources } = verifyCheckout(revision, git, repository);
const { bundle, encodedCommand } = prepareElevation(sources, {
  bundlePath, clientSid, model: 'gpt-6.2-sol', effort: 'max',
  project: 'proj_ci_example', organization: 'org-ci-example', action, setKey: action === 'Enroll'
});
fs.writeFileSync(bundlePath, bundle, { flag: 'wx' });
console.log(encodedCommand);
