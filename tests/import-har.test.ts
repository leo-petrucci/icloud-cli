import { readFile, writeFile } from 'node:fs/promises';
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

describe('importHar', () => {
  it('imports a reusable session from accountLogin request data and headers', async () => {
    tempDir = await makeTempDir('import-har-ok');
    const sessionPath = join(tempDir, 'session.json');
    process.env.ICLOUD_CLI_SESSION_PATH = sessionPath;

    const harPath = join(tempDir, 'login.har');
    await writeFile(harPath, JSON.stringify(makeHar()), 'utf8');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ dsInfo: { primaryEmail: 'user@example.com' } }), { status: 200 })));

    const { importHar } = await import('../src/import-har.js');
    await importHar(harPath);

    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;

    expect(session).toMatchObject({
      accountCountry: 'GBR',
      authAttributes: 'auth-attrs',
      cookies: { a: '1', b: '2', c: '3' },
      extendedLogin: false,
      scnt: 'scnt-value',
      sessionId: 'session-id',
      sessionToken: 'request-token',
      trustToken: 'request-trust',
    });
  });

  it('does not save an invalid HAR unless forced', async () => {
    tempDir = await makeTempDir('import-har-invalid');
    const sessionPath = join(tempDir, 'session.json');
    process.env.ICLOUD_CLI_SESSION_PATH = sessionPath;

    const harPath = join(tempDir, 'login.har');
    await writeFile(harPath, JSON.stringify(makeHar()), 'utf8');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad session' }), { status: 421 })));

    const { importHar } = await import('../src/import-har.js');

    await expect(importHar(harPath)).rejects.toThrow('HAR session is not reusable');
    await expect(readFile(sessionPath, 'utf8')).rejects.toThrow();
  });

  it('saves an invalid HAR when --force is used', async () => {
    tempDir = await makeTempDir('import-har-force');
    const sessionPath = join(tempDir, 'session.json');
    process.env.ICLOUD_CLI_SESSION_PATH = sessionPath;

    const harPath = join(tempDir, 'login.har');
    await writeFile(harPath, JSON.stringify(makeHar()), 'utf8');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad session' }), { status: 421 })));

    const { importHar } = await import('../src/import-har.js');
    await importHar(harPath, { force: true });

    await expect(readFile(sessionPath, 'utf8')).resolves.toContain('request-token');
  });
});

/**
 * Build a small HAR with the fields the importer uses.
 */
function makeHar() {
  return {
    log: {
      entries: [
        {
          request: {
            cookies: [{ name: 'a', value: '1' }],
            headers: [{ name: 'Cookie', value: 'b=2' }],
            postData: {
              text: JSON.stringify({
                accountCountryCode: 'GBR',
                dsWebAuthToken: 'request-token',
                extended_login: false,
                trustToken: 'request-trust',
              }),
            },
            url: 'https://setup.icloud.com/setup/ws/1/accountLogin',
          },
          response: {
            cookies: [{ name: 'c', value: '3' }],
            headers: [
              { name: 'Set-Cookie', value: 'd=4; Path=/' },
              { name: 'scnt', value: 'scnt-value' },
              { name: 'X-Apple-Auth-Attributes', value: 'auth-attrs' },
              { name: 'X-Apple-ID-Account-Country', value: 'USA' },
              { name: 'X-Apple-ID-Session-Id', value: 'session-id' },
              { name: 'X-Apple-Session-Token', value: 'header-token' },
              { name: 'X-Apple-TwoSV-Trust-Token', value: 'header-trust' },
            ],
          },
        },
      ],
    },
  };
}
