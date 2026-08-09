import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir, removeTempDir } from './helpers.js';

let tempDir: string | undefined;

afterEach(async () => {
  vi.resetModules();
  delete process.env.ICLOUD_CLI_SESSION_PATH;

  if (tempDir) {
    await removeTempDir(tempDir);
    tempDir = undefined;
  }
});

describe('session storage', () => {
  it('saves and loads session data from ICLOUD_CLI_SESSION_PATH', async () => {
    tempDir = await makeTempDir('session-save-load');
    process.env.ICLOUD_CLI_SESSION_PATH = join(tempDir, 'session.json');

    const { loadSessionData, saveSessionData } = await import('../src/session.js');

    await saveSessionData({
      accountCountry: 'GBR',
      cookies: { a: 'b' },
      savedAt: '2026-08-09T00:00:00.000Z',
      sessionToken: 'token',
      trustToken: 'trust',
    });

    await expect(loadSessionData()).resolves.toMatchObject({
      accountCountry: 'GBR',
      cookies: { a: 'b' },
      sessionToken: 'token',
      trustToken: 'trust',
    });

    await expect(readFile(join(tempDir, 'session.json'), 'utf8')).resolves.toContain('sessionToken');
  });

  it('gives a useful error when no session exists', async () => {
    tempDir = await makeTempDir('session-missing');
    process.env.ICLOUD_CLI_SESSION_PATH = join(tempDir, 'missing.json');

    const { loadSessionData } = await import('../src/session.js');

    await expect(loadSessionData()).rejects.toThrow('No saved session. Run: icloud-cli login');
  });
});
