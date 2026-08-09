import 'dotenv/config';
import { createHash, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { saveSessionData, SESSION_PATH } from './session.js';

const APPLE_AUTH_BASE = 'https://idmsa.apple.com/appleauth';
const ICLOUD_SETUP_BASE = 'https://setup.icloud.com/setup/ws/1';
const APPLE_WIDGET_KEY = 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d';
const SRP_N = BigInt(
  '0x' +
    'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050' +
    'A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50' +
    'E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8' +
    '55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B' +
    'CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748' +
    '544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB37861602790' +
    '04E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8' +
    'E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F' +
    '9E4AFF73',
);
const SRP_G = 2n;
const SRP_N_BYTES = 256;

const email = process.env.APPLE_ID_EMAIL;
const password = process.env.APPLE_ID_PASSWORD;

if (!email || !password) {
  throw new Error('Missing APPLE_ID_EMAIL or APPLE_ID_PASSWORD in .env');
}

const appleIdEmail = email;
const appleIdPassword = password;

type AppleAuthResponse = {
  status: number;
  headers: Headers;
  bodyText: string;
};

type LoginOptions = {
  debug?: boolean;
};

const initialSessionId = randomUUID().replace(/-/g, '').toUpperCase();
const oauthState = `auth-${randomUUID()}`;

let scnt: string | undefined;
let sessionId: string | undefined = initialSessionId;
let authAttributes: string | undefined;
let accountCountry: string | undefined;
let sessionToken: string | undefined;
let trustToken: string | undefined;
const cookies = new Map<string, string>();

/**
 * Build headers for Apple ID auth requests.
 * These headers make our request look like the iCloud web auth iframe.
 */
const commonHeaders = () => ({
  accept: 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  origin: 'https://idmsa.apple.com',
  referer: 'https://idmsa.apple.com/',
  ...(cookies.size > 0 ? { cookie: serializeCookies() } : {}),
  ...(scnt ? { scnt } : {}),
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'x-apple-domain-id': '3',
  'x-apple-frame-id': oauthState,
  'x-apple-i-fd-client-info': JSON.stringify({
    U: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    L: 'en-US',
    Z: 'GMT+01:00',
    V: '1.1',
    F: '',
  }),
  ...(authAttributes ? { 'x-apple-auth-attributes': authAttributes } : {}),
  ...(sessionId ? { 'x-apple-id-session-id': sessionId } : {}),
  'x-apple-locale': 'en_GB',
  'x-apple-oauth-client-id': APPLE_WIDGET_KEY,
  'x-apple-oauth-client-type': 'firstPartyAuth',
  'x-apple-oauth-redirect-uri': 'https://www.icloud.com',
  'x-apple-oauth-require-grant-code': 'true',
  'x-apple-oauth-response-mode': 'web_message',
  'x-apple-oauth-response-type': 'code',
  'x-apple-oauth-state': oauthState,
  'x-apple-offer-security-upgrade': '1',
  'x-apple-privacy-consent': 'true',
  'x-apple-privacy-consent-accepted': 'true',
  'x-apple-widget-key': APPLE_WIDGET_KEY,
  'x-requested-with': 'XMLHttpRequest',
});

/**
 * Send one request to the Apple ID auth service.
 * Also saves session headers and cookies that Apple returns.
 */
async function appleAuth(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<AppleAuthResponse> {
  const response = await fetch(`${APPLE_AUTH_BASE}${path}`, {
    method,
    headers: commonHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // Apple rotates these values. Always keep the newest value.
  scnt = response.headers.get('scnt') ?? scnt;
  sessionId = response.headers.get('x-apple-id-session-id') ?? sessionId;
  authAttributes = response.headers.get('x-apple-auth-attributes') ?? authAttributes;
  accountCountry = response.headers.get('x-apple-id-account-country') ?? accountCountry;
  sessionToken = response.headers.get('x-apple-session-token') ?? sessionToken;
  trustToken = response.headers.get('x-apple-twosv-trust-token') ?? trustToken;
  storeCookies(response.headers);

  return {
    status: response.status,
    headers: response.headers,
    bodyText: await response.text(),
  };
}

/**
 * Exchange the Apple web auth token for iCloud account data.
 * This also tells us if 2FA is still required.
 */
async function accountLogin() {
  if (!accountCountry || !sessionToken) {
    throw new Error('Missing Apple account country or session token before accountLogin');
  }

  const response = await fetch(`${ICLOUD_SETUP_BASE}/accountLogin`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/json',
      origin: 'https://www.icloud.com',
      referer: 'https://www.icloud.com/',
      ...(cookies.size > 0 ? { cookie: serializeCookies() } : {}),
      'user-agent': commonHeaders()['user-agent'],
    },
    body: JSON.stringify({
      accountCountryCode: accountCountry,
      dsWebAuthToken: sessionToken,
      extended_login: true,
      trustToken: trustToken ?? '',
    }),
  });

  storeCookies(response.headers);

  return {
    status: response.status,
    headers: response.headers,
    bodyText: await response.text(),
  };
}

/**
 * Load the Apple auth state page or JSON state.
 * Apple can return useful 2FA data even when the HTTP status is 500.
 */
async function appleAuthState(accept = 'application/json, text/javascript, */*; q=0.01'): Promise<AppleAuthResponse> {
  const response = await fetch(`${APPLE_AUTH_BASE}/auth`, {
    method: 'GET',
    headers: {
      ...commonHeaders(),
      accept,
    },
  });

  // This endpoint often refreshes the auth headers that the next 2FA call needs.
  scnt = response.headers.get('scnt') ?? scnt;
  sessionId = response.headers.get('x-apple-id-session-id') ?? sessionId;
  authAttributes = response.headers.get('x-apple-auth-attributes') ?? authAttributes;
  accountCountry = response.headers.get('x-apple-id-account-country') ?? accountCountry;
  sessionToken = response.headers.get('x-apple-session-token') ?? sessionToken;
  trustToken = response.headers.get('x-apple-twosv-trust-token') ?? trustToken;
  storeCookies(response.headers);

  return {
    status: response.status,
    headers: response.headers,
    bodyText: await response.text(),
  };
}

/**
 * Ask Apple to send an SMS code to one trusted phone number.
 */
async function requestSmsCode(phoneNumber: PhoneNumber): Promise<AppleAuthResponse> {
  return appleAuth(
    '/auth/verify/phone',
    {
      mode: 'sms',
      phoneNumber,
    },
    'PUT',
  );
}

type SrpClient = {
  secret: bigint;
  publicValue: bigint;
};

type SigninInitChallenge = {
  b: string;
  c: string;
  iteration: number;
  protocol: 's2k' | 's2k_fo';
  salt: string;
};

type PhoneNumber = {
  id: number;
  nonFTEU?: boolean;
};

/**
 * Create the client side of the SRP exchange.
 * SRP lets us prove the password without sending the password to Apple.
 */
function createSrpClient(): SrpClient {
  const secret = bytesToBigInt(randomBytes(32));

  return {
    secret,
    publicValue: modPow(SRP_G, secret, SRP_N),
  };
}

/**
 * Return the public SRP value that Apple expects in signin/init.
 */
function getSrpPublicValue(client: SrpClient): string {
  return padToSrpN(client.publicValue).toString('base64');
}

/**
 * Compute the SRP proof values that Apple expects in signin/complete.
 */
function computeSrpProofs(client: SrpClient, challenge: SigninInitChallenge) {
  const salt = Buffer.from(challenge.salt, 'base64');
  const serverPublicValue = bytesToBigInt(Buffer.from(challenge.b, 'base64'));

  if (serverPublicValue <= 0n || serverPublicValue >= SRP_N) {
    throw new Error('Apple sent an invalid SRP server public value');
  }

  // Apple first derives a password key. SRP then uses that key as the password.
  const derivedPassword = derivePassword(appleIdPassword, salt, challenge.iteration, challenge.protocol);
  const x = calculateX(salt, derivedPassword);
  const u = calculateU(client.publicValue, serverPublicValue);

  if (u === 0n) {
    throw new Error('Calculated SRP scrambling parameter is zero');
  }

  // SRP math. Keep this close to the RFC 5054 formula, but with Apple's password key.
  const multiplier = calculateMultiplier();
  const gToX = modPow(SRP_G, x, SRP_N);
  const base = mod(serverPublicValue - multiplier * gToX, SRP_N);
  const exponent = client.secret + u * x;
  const sharedSecret = padToSrpN(modPow(base, exponent, SRP_N));
  const sessionKey = sha256(sharedSecret);
  const publicBytes = padToSrpN(client.publicValue);
  const serverPublicBytes = padToSrpN(serverPublicValue);
  const m1 = calculateM1(appleIdEmail, salt, publicBytes, serverPublicBytes, sessionKey);
  const m2 = sha256(Buffer.concat([publicBytes, m1, sessionKey]));

  return {
    m1: m1.toString('base64'),
    m2: m2.toString('base64'),
  };
}

/**
 * Derive the Apple SRP password key from the raw password.
 */
function derivePassword(rawPassword: string, salt: Buffer, iterations: number, protocol: string): Buffer {
  const passwordHash = sha256(Buffer.from(rawPassword, 'utf8'));

  if (protocol === 's2k') {
    return pbkdf2Sync(passwordHash, salt, iterations, 32, 'sha256');
  }

  if (protocol === 's2k_fo') {
    return pbkdf2Sync(passwordHash.toString('hex'), salt, iterations, 32, 'sha256');
  }

  throw new Error(`Unsupported Apple SRP protocol: ${protocol}`);
}

/**
 * Calculate the SRP x value.
 * Apple omits the username here. This is called no_username_in_x in other clients.
 */
function calculateX(salt: Buffer, derivedPassword: Buffer): bigint {
  const inner = sha256(Buffer.concat([Buffer.from(':'), derivedPassword]));

  return bytesToBigInt(sha256(Buffer.concat([salt, inner])));
}

/**
 * Calculate the SRP u value.
 * This binds the client and server public values together.
 */
function calculateU(publicValue: bigint, serverPublicValue: bigint): bigint {
  return bytesToBigInt(sha256(Buffer.concat([padToSrpN(publicValue), padToSrpN(serverPublicValue)])));
}

/**
 * Calculate the SRP multiplier k.
 */
function calculateMultiplier(): bigint {
  return bytesToBigInt(sha256(Buffer.concat([bigIntToBytes(SRP_N), padToSrpN(SRP_G)])));
}

/**
 * Calculate the client SRP proof M1.
 * Apple verifies this value to confirm the password proof.
 */
function calculateM1(username: string, salt: Buffer, publicValue: Buffer, serverPublicValue: Buffer, sessionKey: Buffer): Buffer {
  const hashedGenerator = sha256(padToSrpN(SRP_G));
  const hashedPrime = sha256(bigIntToBytes(SRP_N));
  const xor = Buffer.alloc(hashedGenerator.length);

  for (let index = 0; index < xor.length; index += 1) {
    xor[index] = hashedGenerator[index] ^ hashedPrime[index];
  }

  return sha256(Buffer.concat([xor, sha256(Buffer.from(username)), salt, publicValue, serverPublicValue, sessionKey]));
}

/**
 * Return a SHA-256 digest for one buffer.
 */
function sha256(value: Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Left-pad a number to the SRP group byte size.
 */
function padToSrpN(value: bigint): Buffer {
  const bytes = bigIntToBytes(value);
  if (bytes.length >= SRP_N_BYTES) return bytes;

  return Buffer.concat([Buffer.alloc(SRP_N_BYTES - bytes.length), bytes]);
}

/**
 * Convert a bigint to a big-endian buffer.
 */
function bigIntToBytes(value: bigint): Buffer {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
}

/**
 * Convert a big-endian buffer to a bigint.
 */
function bytesToBigInt(value: Buffer): bigint {
  return BigInt(`0x${value.toString('hex') || '0'}`);
}

/**
 * Calculate base^exponent modulo modulus.
 * This avoids very large intermediate numbers.
 */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let currentBase = mod(base, modulus);
  let currentExponent = exponent;

  while (currentExponent > 0n) {
    if (currentExponent % 2n === 1n) {
      result = mod(result * currentBase, modulus);
    }

    currentExponent /= 2n;
    currentBase = mod(currentBase * currentBase, modulus);
  }

  return result;
}

/**
 * Return a positive modulo result.
 */
function mod(value: bigint, modulus: bigint): bigint {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Convert the cookie jar to a Cookie header value.
 */
function serializeCookies(): string {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Save Set-Cookie values from one response into the cookie jar.
 */
function storeCookies(headers: Headers) {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) return;

  for (const cookie of splitSetCookie(setCookie)) {
    const [pair] = cookie.split(';', 1);
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;

    cookies.set(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1));
  }
}

/**
 * Split a combined Set-Cookie header into separate cookie strings.
 */
function splitSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/g).map((cookie) => cookie.trim());
}

/**
 * Parse JSON when possible. Return the original text when parsing fails.
 */
function parseJson(text: string): unknown {
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Redact sensitive response headers before logging.
 */
function redactHeaders(headers: Headers): Record<string, string> {
  const sensitive = /cookie|token|scnt|session|auth|code|trust/i;
  const result: Record<string, string> = {};

  for (const [name, value] of headers.entries()) {
    result[name] = sensitive.test(name) ? '<redacted>' : value;
  }

  return result;
}

/**
 * Redact sensitive values in a response body before logging.
 */
function redactBody(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactBody);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sensitive = /account|apple.?id|auth|code|email|phone|prs|recovery|repair|salt|token|trust|url/i;
  const result: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    result[key] = sensitive.test(key) ? '<redacted>' : redactBody(nestedValue);
  }

  return result;
}

/**
 * Redact email addresses in one string.
 */
function redactString(value: string): string {
  return value
    .replaceAll(appleIdEmail, '<redacted-email>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>');
}

/**
 * Return Apple service error objects from a parsed response body.
 */
function getServiceErrors(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];

  const maybeErrors = (value as { serviceErrors?: unknown }).serviceErrors;
  if (!Array.isArray(maybeErrors)) return [];

  return maybeErrors.filter((error): error is Record<string, unknown> => !!error && typeof error === 'object');
}

/**
 * Return safe service error details for logs.
 */
function summarizeServiceErrors(value: unknown): Array<Record<string, unknown>> {
  return getServiceErrors(value).map((error) => ({
    code: redactBody(error.code),
    message: redactBody(error.message),
    title: redactBody(error.title),
  }));
}

/**
 * Stop when Apple returns an HTTP error or service error list.
 */
function throwIfServiceErrors(context: string, response: AppleAuthResponse) {
  const body = parseJson(response.bodyText);
  const serviceErrors = summarizeServiceErrors(body);

  if (response.status >= 400 || serviceErrors.length > 0) {
    throw new Error(`${context} failed: ${JSON.stringify({ status: response.status, serviceErrors })}`);
  }
}

/**
 * Get the 2FA code from env or ask the user in the terminal.
 */
async function getTwoFactorCode(): Promise<string> {
  const envCode = process.env.APPLE_ID_2FA_CODE?.trim();
  if (envCode) return envCode;

  if (!input.isTTY) {
    throw new Error('2FA is required. Run npm run login from your terminal so you can enter the SMS code.');
  }

  const readline = createInterface({ input, output });
  try {
    return (await readline.question('Enter the Apple SMS code: ')).trim();
  } finally {
    readline.close();
  }
}

/**
 * Save reusable auth data to disk.
 */
async function saveSession() {
  await saveSessionData({
    accountCountry,
    authAttributes,
    cookies: Object.fromEntries(cookies),
    extendedLogin: true,
    savedAt: new Date().toISOString(),
    scnt,
    sessionId,
    sessionToken,
    trustToken,
  });
}

/**
 * Return a small, safe accountLogin summary for logs.
 */
function summarizeAccountLogin(accountData: unknown) {
  if (!accountData || typeof accountData !== 'object') return accountData;

  const data = accountData as {
    hsaChallengeRequired?: unknown;
    hsaTrustedBrowser?: unknown;
    isExtendedLogin?: unknown;
    userPartition?: unknown;
    ckPartition?: unknown;
    webservices?: Record<string, { url?: string }>;
  };

  return {
    hsaChallengeRequired: data.hsaChallengeRequired,
    hsaTrustedBrowser: data.hsaTrustedBrowser,
    isExtendedLogin: data.isExtendedLogin,
    userPartition: data.userPartition,
    ckPartition: data.ckPartition,
    remindersUrl: data.webservices?.reminders?.url,
    ckdatabaseUrl: data.webservices?.ckdatabasews?.url,
  };
}

/**
 * Find trusted phone number objects in parsed Apple auth state.
 */
function findPhoneNumbers(value: unknown): PhoneNumber[] {
  const found: PhoneNumber[] = [];
  const seen = new Set<string>();

  /** Walk nested data and collect objects that look like trusted phone numbers. */
  function visit(node: unknown) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const id = record.id;
    if (typeof id === 'number' && ('nonFTEU' in record || 'obfuscatedNumber' in record || 'numberWithDialCode' in record)) {
      const phoneNumber: PhoneNumber = {
        id,
        ...(typeof record.nonFTEU === 'boolean' ? { nonFTEU: record.nonFTEU } : {}),
      };
      const key = JSON.stringify(phoneNumber);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(phoneNumber);
      }
    }

    for (const nestedValue of Object.values(record)) {
      visit(nestedValue);
    }
  }

  visit(value);
  return found;
}

/**
 * Extract phone verification data from Apple auth state text.
 */
function parsePhoneNumbersFromAuthState(responseText: string): PhoneNumber[] {
  const parsed = parseJson(responseText);
  const fromJson = findPhoneNumbers(parsed);
  if (fromJson.length > 0) return fromJson;

  // Apple sometimes embeds the data in HTML instead of JSON.
  const phones: PhoneNumber[] = [];
  const phoneObjectPattern = /"id"\s*:\s*(\d+)[^{}]{0,500}?"nonFTEU"\s*:\s*(true|false)/g;

  for (const match of responseText.matchAll(phoneObjectPattern)) {
    phones.push({ id: Number(match[1]), nonFTEU: match[2] === 'true' });
  }

  return phones;
}

/**
 * Check if accountLogin says 2FA is still required.
 */
function needsTwoFactorChallenge(accountData: unknown): boolean {
  return !!accountData && typeof accountData === 'object' && (accountData as { hsaChallengeRequired?: unknown }).hsaChallengeRequired === true;
}

/**
 * Print a response only when debug mode is enabled.
 */
function debugResponse(debug: boolean | undefined, label: string, response: AppleAuthResponse, body: unknown = redactBody(parseJson(response.bodyText))) {
  if (!debug) return;

  console.log(label, {
    status: response.status,
    headers: redactHeaders(response.headers),
    body,
  });
}

/**
 * Print a short status line in normal mode.
 */
function logStatus(label: string, response: AppleAuthResponse) {
  console.log(`${label}: ${response.status}`);
}

/**
 * Run the full network-only Apple ID login flow.
 */
export async function login(options: LoginOptions = {}) {
  console.log('Starting Apple auth federate request...');
  const federate = await appleAuth('/auth/federate?isRememberMeEnabled=true', {
    accountName: email,
    rememberMe: false,
  });
  logStatus('federate', federate);
  debugResponse(options.debug, 'federate details', federate);

  console.log('Starting Apple signin init request...');
  const srpClient = createSrpClient();
  const signinInit = await appleAuth('/auth/signin/init', {
    a: getSrpPublicValue(srpClient),
    accountName: email,
    protocols: ['s2k', 's2k_fo'],
  });
  logStatus('signin/init', signinInit);
  debugResponse(options.debug, 'signin/init details', signinInit);

  const challenge = parseJson(signinInit.bodyText);
  if (!isSigninInitChallenge(challenge)) {
    throw new Error('Apple did not return a complete SRP challenge');
  }

  console.log('Starting Apple signin complete request...');
  const proofs = computeSrpProofs(srpClient, challenge);
  const signinComplete = await appleAuth('/auth/signin/complete?isRememberMeEnabled=true', {
    accountName: email,
    c: challenge.c,
    m1: proofs.m1,
    m2: proofs.m2,
    rememberMe: true,
    trustTokens: [],
  });
  logStatus('signin/complete', signinComplete);
  debugResponse(options.debug, 'signin/complete details', signinComplete);

  if (signinComplete.status === 409) {
    // A 409 here means the password proof worked and Apple now wants 2FA.
    console.log('Loading Apple auth page before iCloud challenge setup...');
    const authPage = await appleAuthState('text/html');
    const authPagePhoneCount = parsePhoneNumbersFromAuthState(authPage.bodyText).length;
    console.log(`auth page: ${authPage.status}, phone numbers found: ${authPagePhoneCount}`);
    debugResponse(options.debug, 'auth page details', authPage, { phoneNumbersFound: authPagePhoneCount });

    console.log('Calling iCloud accountLogin to inspect 2FA challenge state...');
    const challengeAccount = await accountLogin();
    const challengeAccountBody = parseJson(challengeAccount.bodyText);
    console.log(`challenge accountLogin: ${challengeAccount.status}`);
    debugResponse(options.debug, 'challenge accountLogin details', challengeAccount, summarizeAccountLogin(challengeAccountBody));

    if (!needsTwoFactorChallenge(challengeAccountBody)) {
      throw new Error('Expected iCloud accountLogin to require a 2FA challenge');
    }

    console.log('Fetching Apple auth state to find phone verification data...');
    const authState = await appleAuthState();
    const phoneNumbers = parsePhoneNumbersFromAuthState(authState.bodyText);
    console.log(`auth state: ${authState.status}, phone numbers found: ${phoneNumbers.length}`);
    debugResponse(options.debug, 'auth state details', authState, { phoneNumbersFound: phoneNumbers.length });

    if (phoneNumbers.length === 0) {
      throw new Error('Could not find phone verification data in Apple auth state response');
    }

    console.log('Requesting Apple SMS code...');
    const sms = await requestSmsCode(phoneNumbers[0]);
    const smsBody = parseJson(sms.bodyText);
    const smsServiceErrors = summarizeServiceErrors(smsBody);
    console.log(`SMS request: ${sms.status}`);
    if (smsServiceErrors.length > 0) console.log('SMS request errors:', smsServiceErrors);
    debugResponse(options.debug, 'SMS request details', sms, {
      serviceErrors: smsServiceErrors,
      body: redactBody(smsBody),
    });
    throwIfServiceErrors('SMS request', sms);

    console.log('Apple phone verification data found. Wait for the SMS code, then enter it here.');
    const code = await getTwoFactorCode();
    console.log('Verifying Apple phone 2FA code...');
    const verify = await appleAuth('/auth/verify/phone/securitycode', {
      mode: 'sms',
      phoneNumber: phoneNumbers[0],
      securityCode: { code },
    });
    const verifyBody = parseJson(verify.bodyText);
    const verifyServiceErrors = summarizeServiceErrors(verifyBody);
    console.log(`phone 2FA verify: ${verify.status}`);
    if (verifyServiceErrors.length > 0) console.log('phone 2FA verify errors:', verifyServiceErrors);
    debugResponse(options.debug, 'phone 2FA verify details', verify, {
      serviceErrors: verifyServiceErrors,
      body: redactBody(verifyBody),
    });
    throwIfServiceErrors('Phone 2FA verification', verify);
  }

  if (!sessionToken) {
    throw new Error('Apple did not return a session token after sign in');
  }

  console.log('Trusting Apple session...');
  const trust = await appleAuth('/auth/2sv/trust');
  logStatus('2FA trust', trust);
  debugResponse(options.debug, '2FA trust details', trust);

  console.log('Calling iCloud accountLogin...');
  const account = await accountLogin();
  const accountBody = parseJson(account.bodyText);
  logStatus('accountLogin', account);
  debugResponse(options.debug, 'accountLogin details', account, summarizeAccountLogin(accountBody));

  await saveSession();
  console.log(`Saved session to ${SESSION_PATH}`);
}

/**
 * Check that signin/init returned a complete SRP challenge.
 */
function isSigninInitChallenge(value: unknown): value is SigninInitChallenge {
  if (!value || typeof value !== 'object') return false;

  const maybeChallenge = value as Partial<SigninInitChallenge>;

  return (
    typeof maybeChallenge.b === 'string' &&
    typeof maybeChallenge.c === 'string' &&
    typeof maybeChallenge.iteration === 'number' &&
    typeof maybeChallenge.protocol === 'string' &&
    typeof maybeChallenge.salt === 'string'
  );
}
