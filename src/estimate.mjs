import { spawn } from 'node:child_process';
import { runCli } from './agents/cli.mjs';
import { CATEGORIES, estimateTask } from './planner.mjs';

export async function localStatus(helperPath) {
  let detail = 'Built-in text rules estimate tasks on this Mac.';
  if (helperPath) {
    try {
      const { code, stdout } = await runCli(helperPath, ['--status'], { timeoutMs: 3500, maxBytes: 1024 });
      const reason = stdout.trim();
      if (code === 0 && reason === 'available') detail = 'Apple Foundation Models is available on this Mac.';
      if (reason === 'modelNotReady') detail += ' The Apple model is still getting ready.';
      if (reason === 'appleIntelligenceNotEnabled') detail += ' Apple Intelligence is turned off.';
    } catch { /* Rules are available on every supported Mac. */ }
  }
  return { installed: true, signedIn: null, detail, models: [] };
}

export function makeEstimator(helperPath) {
  return async (text, context) => {
    const rules = estimateTask(text, context);
    if (!helperPath) return rules;
    try {
      const suggestion = await onDeviceEstimate(helperPath, text);
      const category = CATEGORIES.find(item => item.id === suggestion.category)?.id;
      if (!category || !Number.isInteger(suggestion.minutes) || suggestion.minutes < 5 || suggestion.minutes > 480) return rules;
      // The parser's exact appointment windows are derived from the stated duration.
      const keepDuration = rules.explicitMinutes || (rules.windowStart && rules.windowEnd);
      return {
        ...rules,
        engine: 'apple', category,
        minutes: keepDuration ? rules.minutes : suggestion.minutes,
        reason: keepDuration ? rules.reason : 'On-device estimate · ' + String(suggestion.reason).slice(0, 180)
      };
    } catch { return rules; }
  };
}

function onDeviceEstimate(executable, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 7000 });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 8192) child.kill();
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error('On-device estimate unavailable.'));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}
