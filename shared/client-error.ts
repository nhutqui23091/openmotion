// Node filesystem errors put the resolved absolute path in `message`
// ("ENOENT: no such file or directory, stat '...'"). That text reaches Studio toasts and
// Agent tool results, which is both unhelpful and a disclosure of the local layout, so
// genuine filesystem failures are replaced at the transport boundary while application
// errors keep their own message.

/**
 * True for an error raised by `node:fs`. Those set the failing `syscall` or the resolved
 * `path`, whatever the errno is. A product error that reuses an errno to mean something
 * else, such as the Brand Kit "not found" lookup, sets neither and keeps its message.
 */
export function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  const candidate = error as (NodeJS.ErrnoException & { syscall?: unknown }) | undefined;
  if (!candidate || typeof candidate.code !== 'string') return false;
  return typeof candidate.syscall === 'string' || typeof candidate.path === 'string';
}

/** Message that is safe to show a user or hand to an Agent: no local absolute paths. */
export function clientErrorMessage(error: unknown, fallback: string): string {
  if (isFilesystemError(error)) return `The local file operation failed (${error.code}). Check that the project files still exist and try again.`;
  return error instanceof Error ? error.message : fallback;
}