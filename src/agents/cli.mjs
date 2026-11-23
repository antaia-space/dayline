import { spawn, execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const launch = promisify(execFile);
const loginArgs = { codex: ['login'], agy: [], gemini: [], claude: ['auth', 'login', '--claudeai'] };
const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const binPaths = () => [...new Set([...(process.env.PATH || '').split(path.delimiter), path.join(homedir(), '.local', 'bin'),
  path.join(homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(p => path.isAbsolute(p)))];

export function findCli(provider) {
  if (!Object.hasOwn(loginArgs, provider)) return null;
  const candidates = binPaths().map(dir => path.join(dir, provider));
  if (provider === 'agy' && process.platform === 'darwin') {
    candidates.unshift(path.join(homedir(), 'Library', 'Application Support', 'Dayline', 'bin', 'agy'));
  }
  if (provider === 'codex') candidates.push(bundledCodex, '/Applications/Codex.app/Contents/Resources/codex');
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch { /* Try the next installation. */ }
  }
  return null;
}

// The native client manages its own login. In particular, never inherit API
// keys, base URL overrides, alternate auth homes, or cloud-provider switches.
export function cliEnv() {
  const env = { HOME: homedir(), PATH: binPaths().join(path.delimiter) };
  for (const key of ['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'GOOGLE_CLOUD_PROJECT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function runCli(binary, args, { input = '', cwd, env = cliEnv(), timeoutMs = 60000, maxBytes = 2000000, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failure;
    function stop(message) {
      if (failure) return;
      failure = new Error(message);
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }
    const timer = setTimeout(() => stop('The local client timed out.'), timeoutMs);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) stop('The local client returned too much output.');
        else if (!failure) {
          try {
            if (stream === child.stdout && onStdout) onStdout(chunk);
            chunks.push(chunk);
          } catch { stop('The local client attempted an unsupported action.'); }
        }
      });
    }
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// Only known executables and fixed vendor sign-in commands reach Terminal.
export async function openProviderLogin(provider) {
  const binary = findCli(provider);
  if (!binary || process.platform !== 'darwin') throw new Error('Install the official client on this Mac to open its sign-in.');
  const directory = await mkdtemp(path.join(tmpdir(), 'dayline-login-'));
  const script = path.join(directory, 'Sign in to ' + provider + '.command');
  const env = Object.entries(cliEnv()).map(([key, value]) => quote(key + '=' + value));
  const command = ['/usr/bin/env', '-i', ...env, quote(binary), ...loginArgs[provider].map(quote)].join(' ');
  const contents = ['#!/bin/sh', 'cd ' + quote(directory) + ' || exit 1', 'trap ' + quote('/bin/rm -rf ' + quote(directory)) + ' EXIT', command, ''].join('\n');
  try {
    await writeFile(script, contents, { mode: 0o700 });
    await launch('/usr/bin/open', ['-a', 'Terminal', script]);
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
