import { randomUUID } from 'node:crypto';

import { getRemindersRequestUrl, loadIcloudAccount, remindersHeaders, type IcloudAccount } from './icloud.js';
import type { SessionData } from './session.js';

type RecordValue = Record<string, unknown>;

type ReminderList = {
  ctag: string;
  guid: string;
  title: string;
};

type Reminder = {
  alarms: unknown[];
  completedDate: unknown;
  createdDate: unknown;
  createdDateExtended: unknown;
  dueDateIsAllDay: boolean;
  etag: unknown;
  guid: string;
  lastModifiedDate: unknown;
  pGuid: string;
  priority: unknown;
  startDateIsAllDay: boolean;
  title: string;
};

type StartupData = {
  account: IcloudAccount;
  collections: ReminderList[];
  reminders: Reminder[];
  session: SessionData;
};

type ListOptions = {
  json?: boolean;
};

/**
 * Print active iCloud Reminders grouped by list.
 */
export async function listReminders(options: ListOptions = {}) {
  const startup = await loadStartup();
  const output = startup.collections.map((collection) => ({
    id: collection.guid,
    title: collection.title,
    reminders: startup.reminders
      .filter((reminder) => reminder.pGuid === collection.guid)
      .map((reminder) => ({ id: reminder.guid, title: reminder.title })),
  }));

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  for (const collection of output) {
    console.log(`${safeText(collection.title)} (${collection.id})`);
    for (const reminder of collection.reminders) {
      console.log(`  [ ] ${safeText(reminder.title)} (${reminder.id})`);
    }
  }
}

/**
 * Create one reminder in a named list.
 */
export async function addReminder(title: string, listName: string) {
  if (!title.trim()) throw new Error('Reminder title must not be empty.');

  const startup = await loadStartup();
  const collection = findCollection(startup.collections, listName);
  const now = new Date();
  const reminder = {
    title,
    description: null,
    pGuid: collection.guid,
    etag: null,
    order: null,
    priority: 0,
    recurrence: null,
    alarms: [],
    createdDateExtended: now.getTime(),
    guid: randomUUID().toUpperCase(),
    startDate: null,
    startDateTz: null,
    startDateIsAllDay: false,
    completedDate: null,
    dueDate: null,
    dueDateIsAllDay: false,
    lastModifiedDate: null,
    createdDate: null,
    isFamily: null,
  };

  await mutateReminders(startup, collection, { Reminders: reminder, ClientState: collectionState(startup.collections) });
  console.log(`Added reminder ${safeText(title)} (${reminder.guid})`);
}

/**
 * Add multiple reminders in order. Each reminder uses fresh server state.
 */
export async function addReminders(titles: string[], listName: string) {
  const reminders = titles.map((title) => title.trim()).filter((title) => title.length > 0);
  if (reminders.length === 0) throw new Error('No reminder titles were provided.');

  for (const title of reminders) {
    await addReminder(title, listName);
  }

  console.log(`Added ${reminders.length} reminders.`);
}

/**
 * Mark one active reminder as complete.
 */
export async function completeReminder(reminderId: string) {
  const startup = await loadStartup();
  const reminder = startup.reminders.find((item) => item.guid === reminderId);
  if (!reminder) throw new Error(`No active reminder found with ID: ${reminderId}`);

  const collection = startup.collections.find((item) => item.guid === reminder.pGuid);
  if (!collection) throw new Error('The reminder list is no longer available. Run: icloud-cli reminders list');

  const updatedReminder = {
    guid: reminder.guid,
    pGuid: reminder.pGuid,
    etag: reminder.etag,
    lastModifiedDate: reminder.lastModifiedDate,
    createdDate: reminder.createdDate,
    createdDateExtended: reminder.createdDateExtended,
    priority: reminder.priority,
    title: reminder.title,
    dueDateIsAllDay: reminder.dueDateIsAllDay,
    startDateIsAllDay: reminder.startDateIsAllDay,
    alarms: reminder.alarms,
    completedDate: dateParts(new Date()),
  };

  await mutateReminders(startup, collection, { Reminders: updatedReminder, ClientState: collectionState(startup.collections) });
  console.log(`Completed reminder ${safeText(reminder.title)} (${reminder.guid})`);
}

async function loadStartup(): Promise<StartupData> {
  const { account, session } = await loadIcloudAccount();
  const response = await fetch(getRemindersRequestUrl(account, session, '/startup'), { headers: remindersHeaders(session) });
  const body = await response.json().catch(() => undefined);

  if (!response.ok || !isRecord(body)) {
    throw new Error(`Could not load Reminders (${response.status}).`);
  }

  const collections = records(body.Collections).flatMap(toCollection);
  const reminders = records(body.Reminders).flatMap(toReminder);
  return { account, collections, reminders, session };
}

async function mutateReminders(startup: StartupData, collection: ReminderList, body: RecordValue) {
  const reminder = isRecord(body.Reminders) ? body.Reminders : undefined;
  const ifMatch = typeof reminder?.etag === 'string' ? reminder.etag : undefined;
  const response = await fetch(getRemindersRequestUrl(startup.account, startup.session, `/reminders/${encodeURIComponent(collection.guid)}`, ifMatch), {
    method: 'POST',
    headers: remindersHeaders(startup.session),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Could not update Reminders (${response.status}).`);
  }
}

function findCollection(collections: ReminderList[], name: string): ReminderList {
  const matches = collections.filter((collection) => collection.title === name);
  if (matches.length === 0) throw new Error(`No reminder list found with name: ${name}`);
  if (matches.length > 1) throw new Error(`More than one reminder list has the name: ${name}`);
  return matches[0];
}

function collectionState(collections: ReminderList[]) {
  return { Collections: collections.map(({ ctag, guid }) => ({ ctag, guid })) };
}

function toCollection(value: RecordValue): ReminderList[] {
  const guid = readString(value.guid);
  const title = readString(value.title);
  const ctag = readString(value.ctag);
  return guid && title && ctag ? [{ guid, title, ctag }] : [];
}

function toReminder(value: RecordValue): Reminder[] {
  const guid = readString(value.guid);
  const pGuid = readString(value.pGuid);
  const title = readString(value.title);
  const alarms = Array.isArray(value.alarms) ? value.alarms : [];
  const dueDateIsAllDay = typeof value.dueDateIsAllDay === 'boolean' ? value.dueDateIsAllDay : false;
  const startDateIsAllDay = typeof value.startDateIsAllDay === 'boolean' ? value.startDateIsAllDay : false;

  return guid && pGuid && title
    ? [
        {
          alarms,
          completedDate: value.completedDate,
          createdDate: value.createdDate,
          createdDateExtended: value.createdDateExtended,
          dueDateIsAllDay,
          etag: value.etag,
          guid,
          lastModifiedDate: value.lastModifiedDate,
          pGuid,
          priority: value.priority,
          startDateIsAllDay,
          title,
        },
      ]
    : [];
}

function records(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if ('guid' in value) return [value];
  return Object.values(value).filter(isRecord);
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function dateParts(value: Date): number[] {
  const year = value.getFullYear();
  const month = value.getMonth() + 1;
  const day = value.getDate();

  return [
    year * 10_000 + month * 100 + day,
    year,
    month,
    day,
    value.getHours(),
    value.getMinutes(),
    value.getMilliseconds(),
  ];
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ');
}
