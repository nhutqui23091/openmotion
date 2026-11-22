import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { markdownAnchors, withoutFences, withoutInlineCode } from '../shared/workflow.ts';

export type DocsLinkFinding = { file: string; line: number; target: string; reason: string };

/**
 * Known unresolved links, keyed by file and target rather than by line: an insertion above one of
 * them must not move the exemption, and a different link landing on that line must not inherit it.
 * Each entry is owned by an open change, so the check fails while a listed link resolves and the
 * list cannot silently rot. Nothing is accepted today: the one entry this check started with was
 * corrected on main before it merged.
 */
export const knownBrokenLinks = new Set<string>();

/** A percent escape that does not decode is a finding of its own, not a reason to abort the scan. */
function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

/** Whether the character at `index` is escaped by an odd run of backslashes. */
function escaped(text: string, index: number) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) count++;
  return count % 2 === 1;
}

/**
 * Ported upstream content. Its cross-references describe the upstream repository layout rather than
 * this checkout, so they are reported by the catalogue owner instead of gating every change here.
 */
export const excludedPrefixes = ['library/design/'];

/**
 * Heading slugs are generated lowercase, while an explicit HTML `id` or `name` is used verbatim,
 * because a fragment is matched against the rendered id case-sensitively. Custom anchors are
 * therefore added as written instead of being folded to lower case.
 */
export function markdownAnchorSet(content: string) {
  const anchors = markdownAnchors(content);
  for (const [, id] of content.matchAll(/<a\s+(?:id|name)="([^"]+)"/gi)) anchors.add(id);
  return anchors;
}

/** Example syntax is removed while the line count is preserved, so a finding still names its line. */
export function markdownProse(content: string) {
  return withoutInlineCode(withoutFences(content));
}

/**
 * A link destination in the two forms CommonMark allows: an angle-bracket destination, which may
 * hold spaces, and a plain destination, which may hold balanced parentheses. A reference definition
 * carries the same destination after its label.
 */
const INLINE_LINK = /(!?)\[([^\]]*)\]\(\s*(?:<([^<>\n]*)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/;

/** Every inline link and reference definition on one line, as written. */
function linkDestinations(line: string) {
  const destinations: string[] = [];
  for (const match of line.matchAll(INLINE_LINK)) {
    const at = match.index ?? 0;
    // An escaped bracket renders as literal text, so \[x\](y) and [x\](y) document syntax instead
    // of linking to it. The first closing bracket is the label's, because the label cannot hold one.
    if (escaped(line, at + match[1].length) || escaped(line, at + match[0].indexOf(']'))) continue;
    destinations.push(match[3] ?? match[4]);
  }
  const definition = line.match(REFERENCE_DEFINITION);
  if (definition && !escaped(line, (definition.index ?? 0) + definition[0].indexOf('['))) {
    destinations.push(definition[2] ?? definition[3]);
  }
  return destinations;
}

export function docsLinkFindings(files: Array<{ path: string; content: string }>, trackedFiles?: Iterable<string>): DocsLinkFinding[] {
  // Any tracked file is a valid link target, whatever its extension, and so is a tracked directory.
  const tracked = new Set(trackedFiles ?? files.map(file => file.path));
  const directories = new Set<string>();
  for (const file of tracked) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'));
  }
  // Anchors come from the page itself, because a rendered heading slug keeps its inline code text.
  // Only the link scan runs on the stripped prose, where a quoted example is not a link.
  const anchorsByFile = new Map(files.map(file => [file.path, markdownAnchorSet(withoutFences(file.content))]));
  const findings: DocsLinkFinding[] = [];
  for (const file of files) {
    markdownProse(file.content).split('\n').forEach((line, index) => {
      for (const target of linkDestinations(line)) {
        // URLs, mail links, server-absolute paths and publish-time placeholders are outside the check.
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.includes('{{')) continue;
        const hash = target.indexOf('#');
        const rawFragment = hash === -1 ? undefined : target.slice(hash + 1);
        // A query is not part of the file name, so [x](README.md?plain=1) is a link to README.md.
        const beforeFragment = hash === -1 ? target : target.slice(0, hash);
        const query = beforeFragment.indexOf('?');
        const rawAddress = query === -1 ? beforeFragment : beforeFragment.slice(0, query);
        const address = decode(rawAddress);
        const fragment = rawFragment === undefined ? undefined : decode(rawFragment);
        if (address === undefined || (rawFragment !== undefined && fragment === undefined)) {
          findings.push({ file: file.path, line: index + 1, target, reason: 'malformed percent escape' });
          continue;
        }
        const resolved = address
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file.path), address))
          : file.path;
        if (address && !tracked.has(resolved) && !directories.has(resolved.replace(/\/$/, ''))) {
          findings.push({ file: file.path, line: index + 1, target, reason: `missing target ${resolved}` });
          continue;
        }
        // A bare `#` is a top-of-page link, and an absent fragment has nothing to resolve.
        if (!fragment) continue;
        const anchors = anchorsByFile.get(resolved);
        if (anchors && !anchors.has(fragment)) findings.push({ file: file.path, line: index + 1, target, reason: `missing anchor #${fragment} in ${resolved}` });
      }
    });
  }
  return findings;
}

/**
 * The repository index decides which link targets exist, so a tracked binary or script is a valid
 * target. `-z` keeps the raw bytes of every path: `git ls-files` otherwise C-quotes a non-ASCII name
 * under the default core.quotePath, which would drop such a page from the corpus and hide it as a
 * link target. The index is past one MiB of paths today and keeps growing with templates and media,
 * so an explicit buffer keeps the default from turning the check into a spawn error.
 */
export function trackedFiles(root: string) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
}

/**
 * The repository index lists the pages to check, so a documentation folder inside a dot-directory
 * and a new top-level folder both enter the gate by being committed, and a renamed folder removes
 * its pages instead of silently scanning nothing.
 */
export function markdownFiles(tracked: Iterable<string>) {
  return [...tracked].filter(file => file.toLowerCase().endsWith('.md') && !excludedPrefixes.some(prefix => file.startsWith(prefix))).sort();
}

/** How many pages are read at once; small enough to stay far below a default descriptor limit. */
export const READ_BATCH = 64;

/**
 * Splits findings into the ones a caller must fix and the accepted keys that no longer apply, so an
 * exemption is asserted by file and target rather than by the line it happens to sit on.
 */
export function partitionFindings(findings: DocsLinkFinding[], accepted: ReadonlySet<string> = knownBrokenLinks) {
  return {
    unresolved: findings.filter(finding => !accepted.has(`${finding.file}:${finding.target}`)),
    stale: [...accepted].filter(key => !findings.some(finding => `${finding.file}:${finding.target}` === key)),
  };
}

/** Every tracked Markdown page, its unresolved links, and any accepted entry that no longer applies. */
export async function checkDocsLinks(root: string) {
  const tracked = trackedFiles(root);
  const pages: Array<{ path: string; content: string }> = [];
  // Bounded batches: reading every page through one Promise.all queues one open per page before any
  // of them closes, which exhausts the descriptor limit that Docker and macOS set by default.
  const files = markdownFiles(tracked);
  for (let start = 0; start < files.length; start += READ_BATCH) {
    pages.push(...await Promise.all(files.slice(start, start + READ_BATCH).map(async file => ({ path: file, content: await readFile(path.join(root, file), 'utf8') }))));
  }
  return { files: pages.length, ...partitionFindings(docsLinkFindings(pages, tracked)) };
}
