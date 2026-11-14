import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';

/** Resolve directory aliases even for deleted files, without dereferencing a Git-tracked leaf symlink. */
async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    const parent = dirname(directory);
    if (parent === directory) return directory;
    return join(await canonicalDirectory(parent), basename(directory));
  }
}

export async function uniqueSessionFilePaths(
  links: Array<{ filePath: string; workspaceId?: string }>,
): Promise<string[]> {
  const paths = new Set<string>();
  const directories = new Map<string, Promise<string>>();
  for (const { filePath, workspaceId } of links) {
    // Collaborative page URIs are identities, not filesystem paths.
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(filePath)) {
      paths.add(filePath);
      continue;
    }
    const absolute = isAbsolute(filePath)
      ? normalize(filePath)
      : workspaceId && isAbsolute(workspaceId) ? resolve(workspaceId, filePath) : normalize(filePath);
    // Legacy rows without an absolute workspace retain their relative spelling;
    // resolving against the app process cwd would invent a different file.
    if (!isAbsolute(absolute)) {
      paths.add(absolute);
      continue;
    }
    const directory = dirname(absolute);
    if (!directories.has(directory)) directories.set(directory, canonicalDirectory(directory));
    paths.add(join(await directories.get(directory)!, basename(absolute)));
  }
  return [...paths];
}
