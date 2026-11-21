import { execFileSync } from 'node:child_process';

/**
 * Contributor-workflow material that belongs to one local checkout. It may sit untracked beside the
 * project, but committing it would publish internal notes and third-party skill bundles with the
 * source. This module has no dependencies so a CI step can run it before the dependency install.
 */
export const localOnlyPaths = ['AGENTS_PR_RULE.md', 'PRE-PR.md', 'PR_SKILLS.md', 'AUDIT_PR', 'codex-security', 'superpowers', 'humanizer'];

export function localOnlyOffender(files: string[]): string | undefined {
  return files.find(file => localOnlyPaths.some(entry => file === entry || file.startsWith(entry + '/')));
}

/** Tracked files are the only ones that can reach a commit, so they are the set this guard checks. */
export function trackedFiles(root: string): string[] | undefined {
  try {
    // -z avoids newline escaping, and the buffer covers a checkout far larger than this one.
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  } catch (error) {
    // An installed copy is not a Git checkout, so the guard does not apply there. Every other
    // failure, a buffer overflow or a missing binary included, must surface instead of disabling it.
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr ?? ''))) return undefined;
    throw error;
  }
}
