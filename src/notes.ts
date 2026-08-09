import { randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

import { getCloudKitRequestUrl, jsonHeaders, loadIcloudAccount, type IcloudAccount } from './icloud.js';
import type { SessionData } from './session.js';

const NOTES_CONTAINER = 'com.apple.notes';
const NOTES_ZONE = { zoneName: 'Notes' };
const DEFAULT_FOLDER_TITLE = 'Notes';
const DELETED_FOLDER_TITLE = 'Recently Deleted';

type RecordValue = Record<string, unknown>;

type CloudKitRecord = {
  recordName: string;
  recordType?: string;
  recordChangeTag?: string;
  fields: RecordValue;
  zoneID?: unknown;
};

type NoteFolder = {
  id: string;
  title: string;
  zoneID?: unknown;
};

type NoteRecord = {
  body: string;
  createdAt?: number;
  folderId?: string;
  id: string;
  modifiedAt?: number;
  record: CloudKitRecord;
  snippet: string;
  title: string;
};

type NotesStartup = {
  account: IcloudAccount;
  defaultFolder: NoteFolder;
  deletedFolder: NoteFolder;
  folders: NoteFolder[];
  session: SessionData;
};

type ListOptions = {
  json?: boolean;
};

type ShowOptions = {
  json?: boolean;
};

type AddOptions = {
  body?: string;
};

type EditOptions = {
  body?: string;
  title?: string;
};

/**
 * Print recent iCloud Notes and their IDs.
 */
export async function listNotes(options: ListOptions = {}) {
  const startup = await loadNotesStartup();
  const records = await queryNotes(startup, 100);
  const deletedFolderIds = new Set([startup.deletedFolder.id]);
  const notes = records
    .flatMap(toNoteRecord)
    .filter((note) => !deletedFolderIds.has(note.folderId ?? '') && readNumber(note.record.fields.Deleted) !== 1)
    .map((note) => ({ id: note.id, title: note.title, snippet: note.snippet, modifiedAt: note.modifiedAt }));

  if (options.json) {
    console.log(JSON.stringify(notes, null, 2));
    return;
  }

  for (const note of notes) {
    const snippet = note.snippet && note.snippet !== note.title ? ` - ${safeText(note.snippet)}` : '';
    console.log(`${safeText(note.title)} (${note.id})${snippet}`);
  }
}

/**
 * Print one iCloud Note.
 */
export async function showNote(id: string, options: ShowOptions = {}) {
  const startup = await loadNotesStartup();
  const note = await loadNote(startup, id);
  const output = {
    id: note.id,
    title: note.title,
    body: note.body,
    folderId: note.folderId,
    modifiedAt: note.modifiedAt,
    createdAt: note.createdAt,
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`${safeText(note.title)} (${note.id})`);
  if (note.body) console.log(note.body);
}

/**
 * Add one note to the default Notes folder.
 */
export async function addNote(title: string, options: AddOptions = {}) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error('Note title must not be empty.');

  const startup = await loadNotesStartup();
  const noteText = buildNoteText(normalizedTitle, options.body ?? '');
  const now = Date.now();
  const recordName = randomUUID().toUpperCase();
  const record = buildNoteRecord(recordName, startup.defaultFolder, normalizedTitle, options.body ?? '', noteText, now);

  await modifyNote(startup, [{ operationType: 'create', record }]);
  console.log(`Added note ${safeText(normalizedTitle)} (${recordName})`);
}

/**
 * Replace the title and/or body for one note.
 */
export async function editNote(id: string, options: EditOptions = {}) {
  if (options.title === undefined && options.body === undefined) {
    throw new Error('Provide --title or --body to edit a note.');
  }

  const startup = await loadNotesStartup();
  const note = await loadNote(startup, id);
  const title = options.title === undefined ? note.title : options.title.trim();
  if (!title) throw new Error('Note title must not be empty.');

  const body = options.body === undefined ? note.body : options.body;
  const noteText = buildNoteText(title, body);
  const folder = startup.folders.find((item) => item.id === note.folderId) ?? startup.defaultFolder;
  const record = buildNoteRecord(note.id, folder, title, body, noteText, Date.now(), note.record);

  await modifyNote(startup, [{ operationType: 'update', record }]);
  console.log(`Edited note ${safeText(title)} (${note.id})`);
}

/**
 * Move one note to Recently Deleted.
 */
export async function deleteNote(id: string) {
  const startup = await loadNotesStartup();
  const note = await loadNote(startup, id);
  const record = buildNoteRecord(note.id, startup.deletedFolder, note.title, note.body, buildNoteText(note.title, note.body), Date.now(), note.record);

  await modifyNote(startup, [{ operationType: 'update', record }]);
  console.log(`Deleted note ${safeText(note.title)} (${note.id})`);
}

async function loadNotesStartup(): Promise<NotesStartup> {
  const { account, session } = await loadIcloudAccount();
  const records = await queryFolders(account, session);
  const folders = records.flatMap(toFolder);
  const defaultFolder = findFolder(folders, DEFAULT_FOLDER_TITLE);
  const deletedFolder = findFolder(folders, DELETED_FOLDER_TITLE);

  return { account, defaultFolder, deletedFolder, folders, session };
}

async function queryFolders(account: IcloudAccount, session: SessionData): Promise<CloudKitRecord[]> {
  const body = await cloudKitPost(account, session, 'records/query', {
    query: {
      recordType: 'SearchIndexes',
      filterBy: [
        {
          comparator: 'EQUALS',
          fieldName: 'indexName',
          fieldValue: { value: 'parentless', type: 'STRING' },
        },
      ],
    },
    resultsLimit: 50,
    zoneID: NOTES_ZONE,
  });

  return records(body);
}

async function queryNotes(startup: NotesStartup, resultsLimit: number): Promise<CloudKitRecord[]> {
  const body = await cloudKitPost(startup.account, startup.session, 'records/query', {
    desiredKeys: [
      'TitleEncrypted',
      'SnippetEncrypted',
      'ModificationDate',
      'Deleted',
      'Folder',
      'MinimumSupportedNotesVersion',
    ],
    query: {
      recordType: 'SearchIndexes',
      filterBy: [
        {
          comparator: 'EQUALS',
          fieldName: 'indexName',
          fieldValue: { value: 'recents', type: 'STRING' },
        },
      ],
      sortBy: [{ ascending: false, fieldName: 'modTime' }],
    },
    resultsLimit,
    zoneID: NOTES_ZONE,
  });

  return records(body);
}

async function loadNote(startup: NotesStartup, id: string): Promise<NoteRecord> {
  const body = await cloudKitPost(startup.account, startup.session, 'records/lookup', {
    records: [{ recordName: id }],
    zoneID: NOTES_ZONE,
  });
  const record = records(body).find((item) => item.recordName === id);
  if (!record) throw new Error(`No note found with ID: ${id}`);

  const [note] = toNoteRecord(record);
  if (!note) throw new Error(`No note found with ID: ${id}`);
  return note;
}

async function modifyNote(startup: NotesStartup, operations: RecordValue[]) {
  const response = await cloudKitPost(startup.account, startup.session, 'records/modify', { operations, zoneID: NOTES_ZONE });
  const errors = Array.isArray(response.errors) ? response.errors : [];
  if (errors.length > 0) throw new Error('Could not update Notes.');
}

async function cloudKitPost(account: IcloudAccount, session: SessionData, path: string, body: RecordValue): Promise<RecordValue> {
  const response = await fetch(getCloudKitRequestUrl(account, session, NOTES_CONTAINER, 'private', path), {
    method: 'POST',
    headers: jsonHeaders(session),
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => undefined);

  if (!response.ok || !isRecord(responseBody)) {
    throw new Error(`Could not load Notes (${response.status}).`);
  }

  return responseBody;
}

function buildNoteRecord(recordName: string, folder: NoteFolder, title: string, body: string, noteText: string, now: number, existing?: CloudKitRecord): RecordValue {
  const fields = existing?.fields ?? {};
  const createdAt = readNumber(fields.CreationDate) ?? now;
  const folderRef = folderReference(folder);
  const record: RecordValue = {
    fields: {
      CreationDate: { value: createdAt },
      Folder: { value: folderRef },
      Folders: { value: [folderRef] },
      FoldersModificationDate: { value: now },
      ModificationDate: { value: now },
      SnippetEncrypted: { value: encodeUtf8Base64(body.trim() || title) },
      TitleEncrypted: { value: encodeUtf8Base64(title) },
      FirstAttachmentThumbnail: { value: null },
      FirstAttachmentUTIEncrypted: { value: null },
      TextDataAsset: { value: null },
      TextDataEncrypted: { value: encodeNoteTextData(noteText) },
    },
    recordName,
    recordType: 'Note',
  };

  if (existing?.recordChangeTag) record.recordChangeTag = existing.recordChangeTag;
  return record;
}

function folderReference(folder: NoteFolder) {
  return {
    action: 'VALIDATE',
    recordName: folder.id,
    zoneID: isRecord(folder.zoneID) ? folder.zoneID : NOTES_ZONE,
  };
}

function findFolder(folders: NoteFolder[], title: string): NoteFolder {
  const folder = folders.find((item) => item.title === title);
  if (!folder) throw new Error(`No Notes folder found with name: ${title}`);
  return folder;
}

function toFolder(record: CloudKitRecord): NoteFolder[] {
  if (record.recordType !== 'Folder') return [];
  const title = decodeUtf8Base64(readString(record.fields.TitleEncrypted) ?? '');
  return title ? [{ id: record.recordName, title, zoneID: record.zoneID }] : [];
}

function toNoteRecord(record: CloudKitRecord): NoteRecord[] {
  if (record.recordType !== 'Note') return [];
  const title = decodeUtf8Base64(readString(record.fields.TitleEncrypted) ?? '') || 'Untitled';
  const snippet = decodeUtf8Base64(readString(record.fields.SnippetEncrypted) ?? '');
  const textData = readString(record.fields.TextDataEncrypted);
  const fullText = textData ? decodeNoteTextData(textData) : '';
  const body = readBodyFromNoteText(fullText, title);
  const folder = readReference(record.fields.Folder);

  return [
    {
      body,
      createdAt: readNumber(record.fields.CreationDate),
      folderId: folder?.recordName,
      id: record.recordName,
      modifiedAt: readNumber(record.fields.ModificationDate),
      record,
      snippet,
      title,
    },
  ];
}

function records(body: RecordValue): CloudKitRecord[] {
  const values = Array.isArray(body.records) ? body.records : [];
  return values.filter(isCloudKitRecord);
}

function isCloudKitRecord(value: unknown): value is CloudKitRecord {
  return isRecord(value) && typeof value.recordName === 'string' && isRecord(value.fields);
}

function buildNoteText(title: string, body: string) {
  const normalizedBody = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  return normalizedBody ? `${title}\n\n${normalizedBody}\n` : `${title}\n`;
}

function readBodyFromNoteText(noteText: string, title: string) {
  if (!noteText) return '';
  const withoutTitle = noteText.startsWith(title) ? noteText.slice(title.length) : noteText;
  return withoutTitle.replace(/^\n+/, '').replace(/\n$/, '');
}

function encodeNoteTextData(noteText: string): string {
  const textBytes = Buffer.from(noteText, 'utf8');
  const textLength = [...noteText].length;
  const doc = encodeMessage([
    fieldBytes(2, textBytes),
    fieldBytes(3, textRange(0, 0, 0, 0, 1)),
    fieldBytes(3, textRange(1, 0, 1, 0, 2)),
    fieldBytes(3, textRange(1, Math.max(0, textLength - 1), 1, 0, 3)),
    fieldBytes(3, textRange(1, Math.max(0, textLength - 1), 1, 1, 4)),
    fieldBytes(3, textRange(0, 0xffffffff, 0, 0xffffffff)),
  ]);
  const body = encodeMessage([fieldVarint(1, 0), fieldVarint(2, 0), fieldBytes(3, doc)]);
  const root = encodeMessage([fieldVarint(1, 0), fieldBytes(2, body)]);
  return deflateSync(root).toString('base64');
}

function decodeNoteTextData(value: string): string {
  try {
    const root = parseFields(inflateSync(Buffer.from(value, 'base64')));
    const body = firstBytes(root, 2);
    const bodyFields = body ? parseFields(body) : [];
    const doc = firstBytes(bodyFields, 3);
    const docFields = doc ? parseFields(doc) : [];
    const text = firstBytes(docFields, 2);
    return text ? text.toString('utf8') : '';
  } catch {
    return '';
  }
}

function textRange(start: number, length: number, endStart: number, endLength: number, style?: number): Buffer {
  const parts = [
    fieldBytes(1, encodeMessage([fieldVarint(1, start), fieldVarint(2, length)])),
    fieldVarint(2, start),
    fieldBytes(3, encodeMessage([fieldVarint(1, endStart), fieldVarint(2, endLength)])),
  ];
  if (style !== undefined) parts.push(fieldVarint(5, style));
  return encodeMessage(parts);
}

function encodeMessage(parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

function fieldVarint(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

function fieldBytes(field: number, value: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(value.length), value]);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = BigInt(value >>> 0);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

type ProtoField = { field: number; wire: number; value: Buffer | number };

function parseFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const field = key.value >> 3;
    const wire = key.value & 7;
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      fields.push({ field, wire, value: value.value });
      continue;
    }
    if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      fields.push({ field, wire, value: buffer.subarray(offset, offset + length.value) });
      offset += length.value;
      continue;
    }
    break;
  }
  return fields;
}

function readVarint(buffer: Buffer, start: number) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { offset, value };
}

function firstBytes(fields: ProtoField[], field: number): Buffer | undefined {
  const value = fields.find((item) => item.field === field && Buffer.isBuffer(item.value))?.value;
  return Buffer.isBuffer(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  const field = recordValue(value);
  return typeof field?.value === 'string' ? field.value : undefined;
}

function readNumber(value: unknown): number | undefined {
  const field = recordValue(value);
  return typeof field?.value === 'number' ? field.value : undefined;
}

function readReference(value: unknown): { recordName?: string } | undefined {
  const field = recordValue(value);
  return isRecord(field?.value) ? { recordName: typeof field.value.recordName === 'string' ? field.value.recordName : undefined } : undefined;
}

function recordValue(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function encodeUtf8Base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodeUtf8Base64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ');
}
