import { randomUUID } from 'node:crypto';

import { loadSessionData, saveSessionData, type SessionData } from './session.js';

const ICLOUD_SETUP_BASE = 'https://setup.icloud.com/setup/ws/1';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export type IcloudAccount = {
  dsInfo?: {
    dsid?: unknown;
  };
  webservices?: {
    ckdatabasews?: {
      url?: unknown;
    };
    reminders?: {
      url?: unknown;
    };
  };
};

/**
 * Load a valid account session and its current iCloud service locations.
 */
export async function loadIcloudAccount(): Promise<{ account: IcloudAccount; session: SessionData }> {
  const session = await loadSessionData();

  if (!session.accountCountry || !session.sessionToken) {
    throw new Error('Saved session is missing auth data. Run: icloud-cli login');
  }

  const response = await fetch(`${ICLOUD_SETUP_BASE}/accountLogin`, {
    method: 'POST',
    headers: jsonHeaders(session),
    body: JSON.stringify({
      accountCountryCode: session.accountCountry,
      dsWebAuthToken: session.sessionToken,
      extended_login: session.extendedLogin ?? true,
      trustToken: session.trustToken ?? '',
    }),
  });
  const account = await response.json().catch(() => undefined);

  if (!response.ok || !isIcloudAccount(account) || !account.dsInfo) {
    throw new Error('Saved session is no longer valid. Run: icloud-cli login');
  }

  const updatedSession = ensureClientId(mergeResponseCookies(session, response.headers));
  if (updatedSession !== session) await saveSessionData(updatedSession);

  return { account, session: updatedSession };
}

/**
 * Get the current Reminders service URL from accountLogin data.
 */
export function getRemindersUrl(account: IcloudAccount): string {
  const value = account.webservices?.reminders?.url;
  if (typeof value !== 'string') {
    throw new Error('Your iCloud account does not provide the Reminders service.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Apple returned an invalid Reminders service URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Apple returned an invalid Reminders service URL.');
  }

  // The account response identifies the service host. Reminders calls use its /rd API path.
  url.pathname = '/rd';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Build a Reminders API URL with the account context that the service requires.
 */
export function getRemindersRequestUrl(account: IcloudAccount, session: SessionData, path: string, ifMatch?: string): string {
  const dsid = account.dsInfo?.dsid;
  if (typeof dsid !== 'string' && typeof dsid !== 'number') {
    throw new Error('Apple did not return an account DSID for Reminders.');
  }

  const url = new URL(`${getRemindersUrl(account)}${path}`);
  url.searchParams.set('clientBuildNumber', '2628Build17');
  url.searchParams.set('clientId', session.clientId ?? '');
  url.searchParams.set('clientMasteringNumber', '2628Build17');
  url.searchParams.set('clientVersion', '4.0');
  url.searchParams.set('dsid', String(dsid));
  if (ifMatch) url.searchParams.set('ifMatch', ifMatch);
  url.searchParams.set('lang', 'en-us');
  if (ifMatch) url.searchParams.set('methodOverride', 'PUT');
  url.searchParams.set('usertz', Intl.DateTimeFormat().resolvedOptions().timeZone);
  return url.toString();
}

/**
 * Get the current CloudKit database service URL from accountLogin data.
 */
export function getCloudKitDatabaseUrl(account: IcloudAccount): string {
  const value = account.webservices?.ckdatabasews?.url;
  if (typeof value !== 'string') {
    throw new Error('Your iCloud account does not provide the CloudKit database service.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Apple returned an invalid CloudKit database service URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Apple returned an invalid CloudKit database service URL.');
  }

  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Build a CloudKit database API URL with the account context that the service requires.
 */
export function getCloudKitRequestUrl(account: IcloudAccount, session: SessionData, container: string, scope: 'private' | 'shared', path: string): string {
  const dsid = account.dsInfo?.dsid;
  if (typeof dsid !== 'string' && typeof dsid !== 'number') {
    throw new Error('Apple did not return an account DSID for CloudKit.');
  }

  const url = new URL(`${getCloudKitDatabaseUrl(account)}/database/1/${container}/production/${scope}/${path}`);
  url.searchParams.set('ckjsBuildVersion', '2310ProjectDev27');
  url.searchParams.set('ckjsVersion', '2.6.4');
  url.searchParams.set('clientId', session.clientId ?? '');
  url.searchParams.set('clientBuildNumber', '2628Build17');
  url.searchParams.set('clientMasteringNumber', '2628Build17');
  url.searchParams.set('dsid', String(dsid));
  return url.toString();
}

/**
 * Build the common JSON request headers for authenticated iCloud services.
 */
export function jsonHeaders(session: SessionData): Record<string, string> {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'content-type': 'application/json',
    origin: 'https://www.icloud.com',
    referer: 'https://www.icloud.com/',
    ...(Object.keys(session.cookies).length > 0 ? { cookie: serializeCookies(session.cookies) } : {}),
    'user-agent': USER_AGENT,
  };
}

/**
 * Build the browser-style headers used by the Reminders service.
 */
export function remindersHeaders(session: SessionData): Record<string, string> {
  return {
    ...jsonHeaders(session),
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9,it;q=0.8',
    'content-type': 'text/plain',
    'sec-ch-ua': '"Chromium";v="151", "Not=A?Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  };
}

function isIcloudAccount(value: unknown): value is IcloudAccount {
  return !!value && typeof value === 'object';
}

function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
}

function mergeResponseCookies(session: SessionData, headers: Headers): SessionData {
  const cookies = { ...session.cookies };
  let changed = false;

  for (const value of getSetCookieHeaders(headers)) {
    const [pair] = value.split(';', 1);
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;

    const name = pair.slice(0, separatorIndex);
    const cookieValue = pair.slice(separatorIndex + 1);
    if (cookies[name] === cookieValue) continue;

    cookies[name] = cookieValue;
    changed = true;
  }

  return changed ? { ...session, cookies } : session;
}

function ensureClientId(session: SessionData): SessionData {
  return session.clientId ? session : { ...session, clientId: randomUUID().toUpperCase() };
}

function getSetCookieHeaders(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();

  const value = headers.get('set-cookie');
  return value ? value.split(/,(?=\s*[^;,=]+=[^;,]+)/g) : [];
}
