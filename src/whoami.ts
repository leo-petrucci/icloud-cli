import { loadSessionData } from './session.js';

const ICLOUD_SETUP_BASE = 'https://setup.icloud.com/setup/ws/1';

type WhoamiOptions = {
  debug?: boolean;
  json?: boolean;
};

type AccountLoginResponse = {
  dsInfo?: {
    appleId?: string;
    dsid?: string;
    fullName?: string;
    primaryEmail?: string;
  };
};

/**
 * Print identity data for the saved iCloud session.
 */
export async function whoami(options: WhoamiOptions = {}) {
  const session = await loadSessionData();

  if (!session.accountCountry || !session.sessionToken) {
    throw new Error('Saved session is missing auth data. Run: icloud-cli login');
  }

  const response = await fetch(`${ICLOUD_SETUP_BASE}/accountLogin`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/json',
      origin: 'https://www.icloud.com',
      referer: 'https://www.icloud.com/',
      ...(Object.keys(session.cookies).length > 0 ? { cookie: serializeCookies(session.cookies) } : {}),
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      accountCountryCode: session.accountCountry,
      dsWebAuthToken: session.sessionToken,
      extended_login: session.extendedLogin ?? true,
      trustToken: session.trustToken ?? '',
    }),
  });

  const account = (await response.json()) as AccountLoginResponse;
  const identity = {
    dsid: account.dsInfo?.dsid,
    email: account.dsInfo?.primaryEmail ?? account.dsInfo?.appleId,
    fullName: account.dsInfo?.fullName,
  };

  if (!response.ok || !identity.email) {
    if (options.debug) {
      console.error('accountLogin debug:', {
        status: response.status,
        bodyKeys: account && typeof account === 'object' ? Object.keys(account) : [],
        hasDsInfo: !!account.dsInfo,
      });
    }

    throw new Error('Saved session is no longer valid. Run: icloud-cli login');
  }

  if (options.json) {
    console.log(JSON.stringify(identity, null, 2));
    return;
  }

  const name = identity.fullName ?? 'Unknown user';
  console.log(`Logged in as ${name} <${identity.email}>`);
}

/**
 * Convert saved cookies to a Cookie request header.
 */
function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
}
