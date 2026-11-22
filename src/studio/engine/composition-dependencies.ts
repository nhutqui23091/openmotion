import { posix } from 'node:path';
import { collectSubCompositionSrcs } from '@hyperframes/parsers/asset-resolution';
import { decodedUrlPath } from '@hyperframes/parsers/asset-paths';
import { CloudError } from '../../contracts/errors.ts';
import { resolveVirtualPath } from '../virtual-project-store.ts';

type TextFile = { content: string; version: string };

/** Validate only the reachable subgraph. All versions become preconditions of the parent write. */
export async function readCompositionDependencies(
  target: string, source: string, read: (path: string) => Promise<TextFile | null>,
) {
  const reading = new Set([target]);
  const loaded = new Map<string, TextFile>();
  async function visit(path: string): Promise<TextFile> {
    if (reading.has(path)) {
      throw new CloudError('INVALID_ARGUMENT', 'Composition insertion would create a cycle', { status: 400 });
    }
    const known = loaded.get(path);
    if (known) return known;
    const file = await read(path);
    if (!file) throw new CloudError('NOT_FOUND', 'Composition source was not found', { status: 404 });
    reading.add(path);
    for (const src of collectSubCompositionSrcs(file.content)) {
      const child = resolveVirtualPath(posix.dirname(path), decodedUrlPath(src));
      if (!child) throw new CloudError('INVALID_ARGUMENT', 'Invalid composition source path', { status: 400 });
      await visit(child);
    }
    reading.delete(path);
    loaded.set(path, file);
    return file;
  }
  const file = await visit(source);
  return { file, preconditions: Array.from(loaded, ([path, { version }]) => ({ path, ifMatch: version })) };
}
