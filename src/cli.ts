#!/usr/bin/env node
import { Command } from 'commander';

import { importHar } from './import-har.js';
import { login } from './login.js';
import { addNote, deleteNote, editNote, listNotes, showNote } from './notes.js';
import { addReminder, addReminders, completeReminder, listReminders } from './reminders.js';
import { whoami } from './whoami.js';

const program = new Command();

program
  .name('icloud-cli')
  .description('Network-only iCloud CLI experiments')
  .version('1.0.0');

program
  .command('login')
  .description('Log in to Apple ID and save a reusable iCloud session')
  .option('--debug', 'Print redacted Apple response details')
  .action(async (options: { debug?: boolean }) => {
    await login({ debug: options.debug === true });
  });

program
  .command('import-har')
  .description('Import an existing iCloud browser session from a HAR file')
  .argument('<path>', 'Path to the HAR file')
  .option('--debug', 'Print imported field names, but not secret values')
  .option('--force', 'Save the session even if validation fails')
  .action(async (path: string, options: { debug?: boolean; force?: boolean }) => {
    await importHar(path, { debug: options.debug === true, force: options.force === true });
  });

program
  .command('whoami')
  .description('Show the Apple ID for the saved iCloud session')
  .option('--debug', 'Print safe validation details')
  .option('--json', 'Print identity as JSON')
  .action(async (options: { debug?: boolean; json?: boolean }) => {
    await whoami({ debug: options.debug === true, json: options.json === true });
  });

const reminders = program.command('reminders').description('Manage iCloud Reminders');

reminders
  .command('list')
  .description('List active reminders and their IDs')
  .option('--json', 'Print reminders as JSON')
  .action(async (options: { json?: boolean }) => {
    await listReminders({ json: options.json === true });
  });

reminders
  .command('add')
  .description('Add a reminder to a named list')
  .argument('<title>', 'Reminder title')
  .requiredOption('--list <name>', 'Exact reminder list name')
  .action(async (title: string, options: { list: string }) => {
    await addReminder(title, options.list);
  });

reminders
  .command('add-bulk')
  .description('Add a comma-separated list of reminders')
  .argument('<titles>', 'Comma-separated reminder titles')
  .requiredOption('--list <name>', 'Exact reminder list name')
  .action(async (titles: string, options: { list: string }) => {
    await addReminders(titles.split(','), options.list);
  });

reminders
  .command('complete')
  .description('Mark an active reminder as complete')
  .argument('<id>', 'Reminder ID from reminders list')
  .action(async (id: string) => {
    await completeReminder(id);
  });

const notes = program.command('notes').description('Manage iCloud Notes');

notes
  .command('list')
  .description('List recent notes and their IDs')
  .option('--json', 'Print notes as JSON')
  .action(async (options: { json?: boolean }) => {
    await listNotes({ json: options.json === true });
  });

notes
  .command('show')
  .description('Show one note')
  .argument('<id>', 'Note ID from notes list')
  .option('--json', 'Print the note as JSON')
  .action(async (id: string, options: { json?: boolean }) => {
    await showNote(id, { json: options.json === true });
  });

notes
  .command('add')
  .description('Add a note to the default Notes folder')
  .argument('<title>', 'Note title')
  .option('--body <text>', 'Note body')
  .action(async (title: string, options: { body?: string }) => {
    await addNote(title, { body: options.body });
  });

notes
  .command('edit')
  .description('Edit one note title and/or body')
  .argument('<id>', 'Note ID from notes list')
  .option('--title <title>', 'New note title')
  .option('--body <text>', 'New note body')
  .action(async (id: string, options: { body?: string; title?: string }) => {
    await editNote(id, { body: options.body, title: options.title });
  });

notes
  .command('delete')
  .description('Move one note to Recently Deleted')
  .argument('<id>', 'Note ID from notes list')
  .action(async (id: string) => {
    await deleteNote(id);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
