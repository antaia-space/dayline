// Which receiver this Mac talks to, and which connected Google account it
// proves itself with. Antaia's receiver is the default. Someone who hosts
// their own names it when they start or package Dayline (see AGENTS.md).
export const ANTAIA_RECEIVER = 'https://dayline-calendar.antaia-space.workers.dev';
const ANTAIA_ACCOUNTS = '@antaia.space';

/**
 * origin: HTTPS origin of the receiver; an empty string switches it off.
 * account: the rule receiverAccount() follows.
 * The environment wins over the file a packaged app carries, and that over the default.
 */
export function receiverSettings(env = process.env, bundled = null) {
  const origin = env.DAYLINE_PUSH_RELAY ?? bundled?.origin ?? ANTAIA_RECEIVER;
  // Antaia's receiver serves Antaia's Workspace only, so no other account's identity is sent to it.
  const account = env.DAYLINE_RELAY_ACCOUNT ?? bundled?.account ?? (origin === ANTAIA_RECEIVER ? ANTAIA_ACCOUNTS : '');
  return { origin, account };
}

/** What a build may carry as receiver.json. Throws on anything else, so a typo fails the build and not the app. */
export function checkedReceiverFile(input) {
  const origin = String(input?.origin ?? '').trim(), account = String(input?.account ?? '').trim().toLowerCase();
  if (origin) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('DAYLINE_PUSH_RELAY must be an HTTPS origin, for example https://dayline-calendar.example.workers.dev'); }
    if (url.protocol !== 'https:' || url.origin !== origin.replace(/\/$/, '')) throw new Error('DAYLINE_PUSH_RELAY must be an HTTPS origin without a path.');
  }
  if (account && !/^(?:[^@\s]+)?@[a-z0-9.-]+\.[a-z]{2,}$/.test(account)) throw new Error('DAYLINE_RELAY_ACCOUNT must be an address, or "@" and a domain.');
  return { origin: origin.replace(/\/$/, ''), account };
}

/**
 * The connected account this Mac signs in to the receiver with. Its address
 * also names the booking page. The rule is a full address, "@" and a domain
 * for any account of that domain, or empty: then a Workspace account comes
 * before a personal Gmail one, because a receiver is usually set up for a domain.
 */
export function receiverAccount(accounts, rule = '') {
  const wanted = String(rule).trim().toLowerCase(), address = account => account.email?.toLowerCase() ?? '';
  if (wanted.startsWith('@')) return accounts.find(account => address(account).endsWith(wanted)) ?? null;
  if (wanted) return accounts.find(account => address(account) === wanted) ?? null;
  return accounts.find(account => address(account) && !/@(?:gmail|googlemail)\.com$/.test(address(account))) ?? accounts[0] ?? null;
}
