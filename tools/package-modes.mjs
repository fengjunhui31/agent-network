import { chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// npm puts permission bits into its archive. Normalize staged files, including
// bundled dependencies, so a private build account produces the same artifact.
export async function normalizePackageModes(directory) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const mode = (await stat(file)).mode;
    await chmod(file, mode & 0o111 ? 0o755 : 0o644);
  }
}
