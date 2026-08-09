import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const defaultSessionPath = join(homedir(), 'Library', 'Application Support', 'icloud-cli', 'session.json');

export const SESSION_PATH = process.env.ICLOUD_CLI_SESSION_PATH ?? defaultSessionPath;
export const SESSION_DIR = dirname(SESSION_PATH);

export type SessionData = {
  accountCountry?: string;
  authAttributes?: string;
  clientId?: string;
  cookies: Record<string, string>;
  extendedLogin?: boolean;
  savedAt: string;
  scnt?: string;
  sessionId?: string;
  sessionToken?: string;
  trustToken?: string;
};

/**
 * Save reusable iCloud auth data to disk.
 */
export async function saveSessionData(sessionData: SessionData) {
  await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });

  await writeFile(SESSION_PATH, `${JSON.stringify(sessionData, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Load reusable iCloud auth data from disk.
 */
export async function loadSessionData(): Promise<SessionData> {
  try {
    return JSON.parse(await readFile(SESSION_PATH, 'utf8')) as SessionData;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('No saved session. Run: icloud-cli login');
    }

    throw error;
  }
}
