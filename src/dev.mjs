import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStore, developmentVault } from './store.mjs';
import { makeEstimator } from './estimate.mjs';
import { DaylineService } from './service.mjs';
import { startServer } from './http.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = process.env.DAYLINE_DATA_DIR || path.join(homedir(), 'Library', 'Application Support', 'Dayline Development');
const helper = path.join(root, 'desktop', 'resources', 'estimator');
const service = new DaylineService({
  store: openStore(directory), vault: developmentVault(directory),
  estimate: makeEstimator(existsSync(helper) ? helper : null)
});
const app = await startServer({ service, webRoot: path.join(root, 'web'), port: Number(process.env.DAYLINE_PORT || 43128) });
console.log('Dayline is running. Open this single-use link on this computer:');
console.log(app.launchUrl());
process.on('SIGINT', async () => { await app.close(); process.exit(); });
process.on('SIGTERM', async () => { await app.close(); process.exit(); });
