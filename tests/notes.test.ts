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

describe('Notes commands', () => {
  it('prints recent notes', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), foldersResponse(), notesResponse()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { listNotes } = await import('../src/notes.js');
    await listNotes();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expectCloudKitUrl(fetchMock.mock.calls[1][0], '/database/1/com.apple.notes/production/private/records/query');
    expectCloudKitUrl(fetchMock.mock.calls[2][0], '/database/1/com.apple.notes/production/private/records/query');
    expect(log.mock.calls.map(([line]) => line)).toEqual(['Test note (note-1) - Body text']);
  });

  it('prints structured note data as JSON', async () => {
    await saveTestSession();
    mockFetch([accountResponse(), foldersResponse(), notesResponse()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { listNotes } = await import('../src/notes.js');
    await listNotes({ json: true });

    expect(JSON.parse(log.mock.calls[0][0])).toEqual([
      { id: 'note-1', modifiedAt: 1786269600000, snippet: 'Body text', title: 'Test note' },
    ]);
  });

  it('shows one note', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), foldersResponse(), lookupResponse(noteRecord())]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { showNote } = await import('../src/notes.js');
    await showNote('note-1');

    const lookupBody = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    expect(lookupBody.records).toEqual([{ recordName: 'note-1' }]);
    expect(log).toHaveBeenCalledWith('Test note (note-1)');
  });

  it('adds a note to the default folder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:34:56.000Z'));
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), foldersResponse(), modifyResponse()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { addNote } = await import('../src/notes.js');
    await addNote('New note', { body: 'Body text' });

    const body = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    const operation = body.operations[0];
    expect(operation.operationType).toBe('create');
    expect(operation.record.recordType).toBe('Note');
    expect(operation.record.recordName).toMatch(/^[A-F0-9-]{36}$/);
    expect(operation.record.fields.TitleEncrypted.value).toBe(base64('New note'));
    expect(operation.record.fields.SnippetEncrypted.value).toBe(base64('Body text'));
    expect(operation.record.fields.Folder.value.recordName).toBe('folder-notes');
    expect(operation.record.fields.ModificationDate.value).toBe(Date.now());
    expect(operation.record.fields.TextDataEncrypted.value).toEqual(expect.any(String));
    expect(log.mock.calls[0][0]).toMatch(/^Added note New note \([A-F0-9-]{36}\)$/);
  });

  it('edits a note with its latest change tag', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), foldersResponse(), lookupResponse(noteRecord()), modifyResponse()]);

    const { editNote } = await import('../src/notes.js');
    await editNote('note-1', { title: 'Updated', body: 'New body' });

    const body = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    const operation = body.operations[0];
    expect(operation.operationType).toBe('update');
    expect(operation.record.recordName).toBe('note-1');
    expect(operation.record.recordChangeTag).toBe('tag-1');
    expect(operation.record.fields.TitleEncrypted.value).toBe(base64('Updated'));
    expect(operation.record.fields.SnippetEncrypted.value).toBe(base64('New body'));
  });

  it('moves a note to Recently Deleted', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([accountResponse(), foldersResponse(), lookupResponse(noteRecord()), modifyResponse()]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { deleteNote } = await import('../src/notes.js');
    await deleteNote('note-1');

    const body = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    const operation = body.operations[0];
    expect(operation.operationType).toBe('update');
    expect(operation.record.recordChangeTag).toBe('tag-1');
    expect(operation.record.fields.Folder.value.recordName).toBe('folder-deleted');
    expect(log).toHaveBeenCalledWith('Deleted note Test note (note-1)');
  });

  it('requires an edit field before lookup', async () => {
    await saveTestSession();
    const fetchMock = mockFetch([]);

    const { editNote } = await import('../src/notes.js');

    await expect(editNote('note-1', {})).rejects.toThrow('Provide --title or --body to edit a note.');
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

async function saveTestSession() {
  tempDir = await makeTempDir('notes');
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

function accountResponse() {
  return jsonResponse({
    dsInfo: { dsid: '1' },
    webservices: { ckdatabasews: { url: 'https://cloudkit.example.test' } },
  });
}

function foldersResponse() {
  return jsonResponse({ records: [folderRecord('folder-notes', 'Notes'), folderRecord('folder-deleted', 'Recently Deleted')] });
}

function notesResponse() {
  return jsonResponse({ records: [noteRecord()] });
}

function lookupResponse(record: unknown) {
  return jsonResponse({ records: [record] });
}

function modifyResponse() {
  return jsonResponse({ records: [] });
}

function folderRecord(recordName: string, title: string) {
  return {
    fields: { TitleEncrypted: { value: base64(title) } },
    recordName,
    recordType: 'Folder',
    zoneID: { zoneName: 'Notes' },
  };
}

function noteRecord() {
  return {
    fields: {
      CreationDate: { value: 1786269600000 },
      Deleted: { value: 0 },
      Folder: { value: { recordName: 'folder-notes', zoneID: { zoneName: 'Notes' } } },
      ModificationDate: { value: 1786269600000 },
      SnippetEncrypted: { value: base64('Body text') },
      TitleEncrypted: { value: base64('Test note') },
    },
    recordChangeTag: 'tag-1',
    recordName: 'note-1',
    recordType: 'Note',
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function base64(value: string) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function expectCloudKitUrl(value: unknown, pathname: string) {
  const url = new URL(String(value));
  expect(url.origin).toBe('https://cloudkit.example.test');
  expect(url.pathname).toBe(pathname);
  expect(url.searchParams.get('ckjsBuildVersion')).toBe('2310ProjectDev27');
  expect(url.searchParams.get('ckjsVersion')).toBe('2.6.4');
  expect(url.searchParams.get('clientId')).toMatch(/^[A-F0-9-]{36}$/);
  expect(url.searchParams.get('clientBuildNumber')).toBe('2628Build17');
  expect(url.searchParams.get('clientMasteringNumber')).toBe('2628Build17');
  expect(url.searchParams.get('dsid')).toBe('1');
  return url;
}
