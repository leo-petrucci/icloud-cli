#!/usr/bin/env node
import { Command } from 'commander';

import { importHar } from './import-har.js';
import { login } from './login.js';
import { whoami } from './whoami.js';

const program = new Command();

program
  .name('icloud-cli')
  .description('Network-only iCloud CLI experiments')
  .version('0.1.0');

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

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
