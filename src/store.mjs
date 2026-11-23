import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export function defaultSettings() {
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    workDays: [1, 2, 3, 4, 5],
    startTime: '09:00',
    endTime: '17:00',
    excludedCalendarIds: [],
    targetCalendarId: 'primary'
  };
}

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'planner.json');
  const state = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { version: 1, settings: defaultSettings(), tasks: [], accounts: [], client: null, lastSync: null };
  if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.accounts)) {
    throw new Error('This Dayline data file is unreadable or belongs to a newer version.');
  }
  return {
    state,
    save() {
      const temp = file + '.next';
      const fd = openSync(temp, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(state), 'utf8');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, file);
    }
  };
}

// The standalone development server has its own directory. The Mac app uses Keychain.
export function developmentVault(directory) {
  const file = path.join(directory, 'development.key');
  let key;
  function localKey() {
    if (!key) {
      if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
      key = readFileSync(file);
    }
    return key;
  }
  return {
    async seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', localKey(), iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    async open(value) {
      const data = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', localKey(), data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    }
  };
}
