import { readFile } from 'node:fs/promises';

import { saveSessionData, SESSION_PATH, type SessionData } from './session.js';

type Har = {
  log?: {
    entries?: HarEntry[];
  };
};

type HarEntry = {
  request?: {
    cookies?: HarCookie[];
    headers?: HarHeader[];
    postData?: {
      text?: string;
    };
    url?: string;
  };
  response?: {
    cookies?: HarCookie[];
    headers?: HarHeader[];
  };
};

type HarCookie = {
  name?: string;
  value?: string;
};

type HarHeader = {
  name?: string;
  value?: string;
};

type ImportHarOptions = {
  debug?: boolean;
  force?: boolean;
};

type AccountLoginResponse = {
  dsInfo?: unknown;
};

/**
 * Import iCloud auth state from a browser HAR export.
 */
export async function importHar(filePath: string, options: ImportHarOptions = {}) {
  const har = JSON.parse(await readFile(filePath, 'utf8')) as Har;
  const entries = har.log?.entries ?? [];
  const cookies = new Map<string, string>();
  const session: Partial<SessionData> = {};

  for (const entry of entries) {
    collectCookies(cookies, entry.request?.cookies ?? []);
    collectCookies(cookies, entry.response?.cookies ?? []);
    collectCookieHeaders(cookies, entry.request?.headers ?? []);
    collectSetCookieHeaders(cookies, entry.response?.headers ?? []);
    collectSessionHeaders(session, entry.response?.headers ?? []);
    collectAccountLoginRequest(session, entry);
  }

  const sessionData: SessionData = {
    ...session,
    cookies: Object.fromEntries(cookies),
    savedAt: new Date().toISOString(),
  };

  if (!sessionData.sessionToken) {
    throw new Error('No Apple session token found in HAR. Export the HAR after a successful iCloud login.');
  }

  const validation = await validateSession(sessionData);
  if (!validation.valid && !options.force) {
    throw new Error(
      `HAR session is not reusable. accountLogin returned ${validation.status}. ` +
        `Cookies imported: ${cookies.size}. Export a HAR with cookies, or run: icloud-cli login`,
    );
  }

  await saveSessionData(sessionData);

  console.log(`Imported session to ${SESSION_PATH}`);
  console.log(`Cookies imported: ${cookies.size}`);
  console.log(`Session validation: ${validation.valid ? 'ok' : `failed (${validation.status})`}`);
  if (options.debug) {
    console.log('Fields imported:', {
      accountCountry: !!sessionData.accountCountry,
      authAttributes: !!sessionData.authAttributes,
      scnt: !!sessionData.scnt,
      sessionId: !!sessionData.sessionId,
      sessionToken: !!sessionData.sessionToken,
      trustToken: !!sessionData.trustToken,
    });
  }
}

/**
 * Check if imported auth data can call iCloud accountLogin.
 */
async function validateSession(sessionData: SessionData): Promise<{ status: number; valid: boolean }> {
  if (!sessionData.accountCountry || !sessionData.sessionToken) {
    return { status: 0, valid: false };
  }

  const response = await fetch('https://setup.icloud.com/setup/ws/1/accountLogin', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/json',
      origin: 'https://www.icloud.com',
      referer: 'https://www.icloud.com/',
      ...(Object.keys(sessionData.cookies).length > 0 ? { cookie: serializeCookies(sessionData.cookies) } : {}),
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      accountCountryCode: sessionData.accountCountry,
      dsWebAuthToken: sessionData.sessionToken,
      extended_login: sessionData.extendedLogin ?? true,
      trustToken: sessionData.trustToken ?? '',
    }),
  });

  const body = (await response.json().catch(() => undefined)) as AccountLoginResponse | undefined;

  return { status: response.status, valid: response.ok && !!body?.dsInfo };
}

/**
 * Convert saved cookies to a Cookie request header.
 */
function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Add HAR cookie objects to the cookie jar.
 */
function collectCookies(cookies: Map<string, string>, harCookies: HarCookie[]) {
  for (const cookie of harCookies) {
    if (!cookie.name || cookie.value === undefined) continue;
    cookies.set(cookie.name, cookie.value);
  }
}

/**
 * Add cookies from Set-Cookie headers to the cookie jar.
 */
function collectSetCookieHeaders(cookies: Map<string, string>, headers: HarHeader[]) {
  for (const header of headers) {
    if (!header.name || !header.value || header.name.toLowerCase() !== 'set-cookie') continue;

    for (const cookie of splitSetCookie(header.value)) {
      const [pair] = cookie.split(';', 1);
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex === -1) continue;

      cookies.set(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1));
    }
  }
}

/**
 * Add cookies from Cookie request headers to the cookie jar.
 */
function collectCookieHeaders(cookies: Map<string, string>, headers: HarHeader[]) {
  for (const header of headers) {
    if (!header.name || !header.value || header.name.toLowerCase() !== 'cookie') continue;

    for (const pair of header.value.split(';')) {
      const trimmed = pair.trim();
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) continue;

      cookies.set(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
    }
  }
}

/**
 * Save token data from an accountLogin request body.
 */
function collectAccountLoginRequest(session: Partial<SessionData>, entry: HarEntry) {
  if (!entry.request?.url?.includes('/setup/ws/1/accountLogin')) return;

  const body = parseJsonObject(entry.request.postData?.text ?? '');
  if (!body) return;

  session.accountCountry = readString(body.accountCountryCode) ?? session.accountCountry;
  session.sessionToken = readString(body.dsWebAuthToken) ?? session.sessionToken;
  session.trustToken = readString(body.trustToken) ?? session.trustToken;
  session.extendedLogin = typeof body.extended_login === 'boolean' ? body.extended_login : session.extendedLogin;
}

/**
 * Save Apple auth headers from one HAR response.
 */
function collectSessionHeaders(session: Partial<SessionData>, headers: HarHeader[]) {
  const headerMap = new Map(headers.map((header) => [header.name?.toLowerCase(), header.value]));

  session.accountCountry = headerMap.get('x-apple-id-account-country') ?? session.accountCountry;
  session.authAttributes = headerMap.get('x-apple-auth-attributes') ?? session.authAttributes;
  session.scnt = headerMap.get('scnt') ?? session.scnt;
  session.sessionId = headerMap.get('x-apple-id-session-id') ?? session.sessionId;
  session.sessionToken = headerMap.get('x-apple-session-token') ?? session.sessionToken;
  session.trustToken = headerMap.get('x-apple-twosv-trust-token') ?? session.trustToken;
}

/**
 * Parse a JSON object, or return undefined.
 */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read one string value from unknown data.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Split a combined Set-Cookie header into separate cookie strings.
 */
function splitSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/g).map((cookie) => cookie.trim());
}
