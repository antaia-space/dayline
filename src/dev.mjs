import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStore, developmentVault } from './store.mjs';
import { TaskAgents } from './agents/manager.mjs';
import { DaylineService } from './service.mjs';
import { startServer } from './http.mjs';
import { receiverSettings } from './receiver-choice.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = process.env.DAYLINE_DATA_DIR || path.join(homedir(), 'Library', 'Application Support', 'Dayline Development');
const helper = path.join(root, 'desktop', 'resources', 'estimator');
const store = openStore(directory);
const agents = new TaskAgents({ store, helperPath: existsSync(helper) ? helper : null });
// The development server uses a receiver only when DAYLINE_PUSH_RELAY names one.
const relay = process.env.DAYLINE_PUSH_RELAY;
const service = new DaylineService({
  store, vault: developmentVault(directory),
  estimate: (text, context) => agents.estimate(text, context), relayAccount: receiverSettings().account
});
const app = await startServer({ service, agents, webRoot: path.join(root, 'web'), port: Number(process.env.DAYLINE_PORT || 43128),
  calendarPushOptions: relay ? { origin: relay } : undefined });
console.log('Dayline is running. Open this single-use link on this computer:');
console.log(app.launchUrl());
process.on('SIGINT', async () => { await app.close(); process.exit(); });
process.on('SIGTERM', async () => { await app.close(); process.exit(); });
