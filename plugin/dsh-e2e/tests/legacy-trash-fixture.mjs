import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Tests only: emulate an existing pre-upgrade recycled record without calling
// the current permanent-delete API or touching any installed user data.
export async function legacyTrashFixture(root, scope, ids, { batchId = randomUUID(), deletedAt = new Date().toISOString() } = {}) {
  const bucket = createHash('sha256').update(scope.sessionId).digest('hex');
  const directory = join(root, 'log-library', 'trash', bucket, batchId);
  await mkdir(directory, { recursive: true });
  for (const id of ids) {
    const source = join(root, 'log-library', 'sessions', bucket, id);
    const metadata = JSON.parse(await readFile(join(source, 'library.json'), 'utf8'));
    await writeFile(join(source, 'library.json'), JSON.stringify({ ...metadata, deletedAt }));
    await rename(source, join(directory, id));
  }
  return { batchId, directory, deletedAt };
}
