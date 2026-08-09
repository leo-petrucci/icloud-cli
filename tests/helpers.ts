import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a temporary directory for one test.
 */
export async function makeTempDir(name: string) {
  const dir = join(tmpdir(), `icloud-cli-${name}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });

  return dir;
}

/**
 * Remove a temporary directory after one test.
 */
export async function removeTempDir(dir: string) {
  await rm(dir, { force: true, recursive: true });
}
