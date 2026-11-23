import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export function defaultSettings() {
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    workDays: [1, 2, 3, 4, 5],
    startTime: '09:00',
    endTime: '17:00',
    calendarMode: 'availability',
    excludedCalendarIds: [],
    targetCalendarId: 'primary'
  };
}

// Accounts saved before calendar modes used Google's event-write scope. Keeping
// that capability separate from the global mode avoids upgrading newer grants.
export function migrateCalendarModes(state) {
  let changed = false;
  if (!['availability', 'sync'].includes(state.settings.calendarMode)) {
    state.settings.calendarMode = 'availability';
    changed = true;
  }
  for (const account of state.accounts) {
    if (account.mode === 'availability' || account.mode === 'sync') continue;
    account.mode = account.mode === undefined ? 'sync' : 'availability';
    changed = true;
  }
  return changed;
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
  const store = {
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
  if (migrateCalendarModes(state)) store.save();
  return store;
}

// macOS can keep a Safe Storage request pending until the owner answers a
// system dialog. Release the planner queue and share that one native prompt.
export function keychainVault(safeStorage, timeoutMs = 12000) {
  const pending = new Map();
  const approval = 'Allow Dayline Safe Storage in the macOS Keychain prompt, then choose Refresh availability in Dayline.';

  function access(method, value, operation) {
    const key = method + createHash('sha256').update(value).digest('hex');
    const existing = pending.get(key);
    if (existing) return existing;
    const request = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error(approval), { status: 423 })), timeoutMs);
      Promise.resolve().then(operation).then(resolve, () => reject(Object.assign(new Error(approval), { status: 423 })))
        .finally(() => { clearTimeout(timer); pending.delete(key); });
    });
    pending.set(key, request);
    return request;
  }

  return {
    seal(value) {
      return access('seal', value, async () => {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error(approval);
        return (await safeStorage.encryptStringAsync(value)).toString('base64');
      });
    },
    open(value) {
      return access('open', value, async () => (await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result);
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
