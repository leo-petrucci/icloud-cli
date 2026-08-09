import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir, removeTempDir } from './helpers.js';

let tempDir: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.ICLOUD_CLI_SESSION_PATH;

  if (tempDir) {
    await removeTempDir(tempDir);
    tempDir = undefined;
  }
});

describe('Reminders commands', () => {
  it('prints active reminders grouped by list', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), startupResponse()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { listReminders } = await import('../src/reminders.js');
    await listReminders();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectRemindersUrl(fetchMock.mock.calls[1][0], '/rd/startup');
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'Inbox (list-1)',
      '  [ ] Buy milk (reminder-1)',
    ]);
  });

  it('prints structured reminder data as JSON', async () => {
    await saveTestSession();
    mockFetch([accountResponse(), startupResponse()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { listReminders } = await import('../src/reminders.js');
    await listReminders({ json: true });

    expect(JSON.parse(log.mock.calls[0][0])).toEqual([
      {
        id: 'list-1',
        title: 'Inbox',
        reminders: [{ id: 'reminder-1', title: 'Buy milk' }],
      },
    ]);
  });

  it('uses web-auth cookies returned by accountLogin for the Reminders request', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(['web-auth=fresh; Path=/']), startupResponse()]);

    const { listReminders } = await import('../src/reminders.js');
    await listReminders();

    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(options.headers).toMatchObject({ cookie: 'session=test; web-auth=fresh' });
  });

  it('adds a reminder with the current collection state', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), startupResponse(), changeSetResponse()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { addReminder } = await import('../src/reminders.js');
    await addReminder('Buy bread', 'Inbox');

    const [url, options] = fetchMock.mock.calls[2] as [string, RequestInit];
    const body = JSON.parse(String(options.body));

    const requestUrl = expectRemindersUrl(url, '/rd/reminders/list-1');
    expect(requestUrl.searchParams.has('ifMatch')).toBe(false);
    expect(requestUrl.searchParams.has('methodOverride')).toBe(false);
    expect(options.method).toBe('POST');
    expect(body.ClientState).toEqual({ Collections: [{ ctag: 'ctag-1', guid: 'list-1' }] });
    expect(body.Reminders).toMatchObject({
      alarms: [],
      completedDate: null,
      description: null,
      dueDate: null,
      guid: expect.stringMatching(/^[A-F0-9-]{36}$/),
      pGuid: 'list-1',
      priority: 0,
      title: 'Buy bread',
    });
    expect(log.mock.calls[0][0]).toMatch(/^Added reminder Buy bread \([A-F0-9-]{36}\)$/);
  });

  it('adds bulk reminders in order with fresh server state', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([
      accountResponse(),
      startupResponse(),
      changeSetResponse(),
      accountResponse(),
      startupResponse(),
      changeSetResponse(),
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { addReminders } = await import('../src/reminders.js');
    await addReminders(['Buy bread', 'Buy fruit'], 'Inbox');

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body)).Reminders.title).toBe('Buy bread');
    expect(JSON.parse(String((fetchMock.mock.calls[5][1] as RequestInit).body)).Reminders.title).toBe('Buy fruit');
    expect(log).toHaveBeenLastCalledWith('Added 2 reminders.');
  });

  it('completes a reminder with its saved fields and current collection state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 9, 12, 34, 56, 789));
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), startupResponse(), changeSetResponse()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { completeReminder } = await import('../src/reminders.js');
    await completeReminder('reminder-1');

    const [url, options] = fetchMock.mock.calls[2] as [string, RequestInit];
    const body = JSON.parse(String(options.body));

    const requestUrl = expectRemindersUrl(url, '/rd/reminders/list-1');
    expect(requestUrl.searchParams.get('ifMatch')).toBe('etag-1');
    expect(requestUrl.searchParams.get('methodOverride')).toBe('PUT');
    expect(body.ClientState).toEqual({ Collections: [{ ctag: 'ctag-1', guid: 'list-1' }] });
    expect(body.Reminders).toMatchObject({
      alarms: [],
      createdDate: [20260809, 2026, 8, 9, 10, 0, 0],
      createdDateExtended: 1786269600000,
      etag: 'etag-1',
      guid: 'reminder-1',
      pGuid: 'list-1',
      title: 'Buy milk',
    });
    expect(body.Reminders.completedDate).toEqual([20260809, 2026, 8, 9, 12, 34, 789]);
    expect(body.Reminders).not.toHaveProperty('description');
    expect(log).toHaveBeenCalledWith('Completed reminder Buy milk (reminder-1)');
  });

  it('rejects an ambiguous list name before sending a mutation', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), startupResponse({ duplicateList: true })]);

    const { addReminder } = await import('../src/reminders.js');

    await expect(addReminder('Buy bread', 'Inbox')).rejects.toThrow('More than one reminder list has the name: Inbox');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an expired saved session before calling Reminders', async () => {
    await saveTestSession();
    mockFetch([jsonResponse({ error: 'expired' }, 421)]);

    const { listReminders } = await import('../src/reminders.js');

    await expect(listReminders()).rejects.toThrow('Saved session is no longer valid. Run: icloud-cli login');
  });
});

async function saveTestSession() {
  tempDir = await makeTempDir('reminders');
  process.env.ICLOUD_CLI_SESSION_PATH = join(tempDir, 'session.json');

  const { saveSessionData } = await import('../src/session.js');
  await saveSessionData({
    accountCountry: 'GBR',
    cookies: { session: 'test' },
    savedAt: '2026-08-09T00:00:00.000Z',
    sessionToken: 'token',
  });
}

function mockFetch(responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function accountResponse(cookies: string[] = []) {
  return jsonResponse({
    dsInfo: { dsid: '1' },
    webservices: { reminders: { url: 'https://reminders.example.test' } },
  }, 200, cookies);
}

function startupResponse(options: { duplicateList?: boolean } = {}) {
  const collections = [
    { ctag: 'ctag-1', guid: 'list-1', title: 'Inbox' },
    ...(options.duplicateList ? [{ ctag: 'ctag-2', guid: 'list-2', title: 'Inbox' }] : []),
  ];

  return jsonResponse({
    Collections: collections,
    Reminders: [
      {
        alarms: [],
        completedDate: null,
        createdDate: [20260809, 2026, 8, 9, 10, 0, 0],
        createdDateExtended: 1786269600000,
        dueDateIsAllDay: false,
        etag: 'etag-1',
        guid: 'reminder-1',
        lastModifiedDate: [20260809, 2026, 8, 9, 10, 0, 0],
        pGuid: 'list-1',
        priority: 0,
        startDateIsAllDay: false,
        title: 'Buy milk',
      },
    ],
  });
}

function changeSetResponse() {
  return jsonResponse({ ChangeSet: {} });
}

function jsonResponse(body: unknown, status = 200, cookies: string[] = []) {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { headers, status });
}

function expectRemindersUrl(value: unknown, pathname: string) {
  const url = new URL(String(value));
  expect(url.origin).toBe('https://reminders.example.test');
  expect(url.pathname).toBe(pathname);
  expect(url.searchParams.get('clientBuildNumber')).toBe('2628Build17');
  expect(url.searchParams.get('clientId')).toMatch(/^[A-F0-9-]{36}$/);
  expect(url.searchParams.get('clientMasteringNumber')).toBe('2628Build17');
  expect(url.searchParams.get('clientVersion')).toBe('4.0');
  expect(url.searchParams.get('dsid')).toBe('1');
  expect(url.searchParams.get('lang')).toBe('en-us');
  expect(url.searchParams.get('usertz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return url;
}
