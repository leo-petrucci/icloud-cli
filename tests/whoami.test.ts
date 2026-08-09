import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir, removeTempDir } from './helpers.js';

let tempDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.ICLOUD_CLI_SESSION_PATH;

  if (tempDir) {
    await removeTempDir(tempDir);
    tempDir = undefined;
  }
});

describe('whoami', () => {
  it('prints the logged in user from accountLogin', async () => {
    tempDir = await makeTempDir('whoami-text');
    process.env.ICLOUD_CLI_SESSION_PATH = join(tempDir, 'session.json');

    const { saveSessionData } = await import('../src/session.js');
    await saveSessionData({
      accountCountry: 'GBR',
      cookies: {},
      savedAt: '2026-08-09T00:00:00.000Z',
      sessionToken: 'token',
      trustToken: 'trust',
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ dsInfo: { dsid: '1', fullName: 'Ada Lovelace', primaryEmail: 'ada@example.com' } }), { status: 200 })));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { whoami } = await import('../src/whoami.js');
    await whoami();

    expect(log).toHaveBeenCalledWith('Logged in as Ada Lovelace <ada@example.com>');
  });

  it('prints JSON when requested', async () => {
    tempDir = await makeTempDir('whoami-json');
    process.env.ICLOUD_CLI_SESSION_PATH = join(tempDir, 'session.json');

    const { saveSessionData } = await import('../src/session.js');
    await saveSessionData({
      accountCountry: 'GBR',
      cookies: {},
      savedAt: '2026-08-09T00:00:00.000Z',
      sessionToken: 'token',
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ dsInfo: { dsid: '2', fullName: 'Grace Hopper', primaryEmail: 'grace@example.com' } }), { status: 200 })));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { whoami } = await import('../src/whoami.js');
    await whoami({ json: true });

    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      dsid: '2',
      email: 'grace@example.com',
      fullName: 'Grace Hopper',
    });
  });

  it('reports an invalid saved session', async () => {
    tempDir = await makeTempDir('whoami-invalid');
    process.env.ICLOUD_CLI_SESSION_PATH = join(tempDir, 'session.json');

    const { saveSessionData } = await import('../src/session.js');
    await saveSessionData({
      accountCountry: 'GBR',
      cookies: {},
      savedAt: '2026-08-09T00:00:00.000Z',
      sessionToken: 'token',
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad session' }), { status: 421 })));

    const { whoami } = await import('../src/whoami.js');

    await expect(whoami()).rejects.toThrow('Saved session is no longer valid. Run: icloud-cli login');
  });
});
