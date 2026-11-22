import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocsLinks, docsLinkFindings, knownBrokenLinks, markdownAnchorSet, markdownFiles, partitionFindings, READ_BATCH, trackedFiles } from '../scripts/check-docs-links.ts';
import { withoutFences } from '../shared/workflow.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const page = (path: string, content: string) => ({ path, content });

test('a page anchor set covers heading slugs and explicit HTML anchors as written', () => {
  const anchors = markdownAnchorSet('## Install in your agent\n\n<a id="connect-your-agent"></a>\n\n<a name="Local-Agent-Connection"></a>\n');
  assert.ok(anchors.has('install-in-your-agent'));
  assert.ok(anchors.has('connect-your-agent'));
  assert.ok(anchors.has('Local-Agent-Connection'));
  // A fragment is matched against the rendered id, so a differently cased one is a different anchor.
  assert.equal(anchors.has('local-agent-connection'), false);
});

test('a heading keeps its inline code when its anchor is generated', () => {
  const heading = '## Design Studio HTML tools (`openmotion_design_*`)\n';
  // The rendered slug keeps the code span, so the anchor ends with the tool prefix, not with a bare hyphen.
  assert.ok(markdownAnchorSet(heading).has('design-studio-html-tools-openmotion_design_'));
  const files = [page('docs/a.md', '[tools](b.md#design-studio-html-tools-openmotion_design_)\n[example](b.md#design-studio-html-tools-)\n'), page('docs/b.md', heading)];
  assert.deepEqual(docsLinkFindings(files).map(finding => [finding.line, finding.reason]), [[2, 'missing anchor #design-studio-html-tools- in docs/b.md']]);
});

test('a fragment is compared case-sensitively', () => {
  const files = [page('docs/a.md', '[wrong case](b.md#FOO-BAR)\n[heading case](b.md#Foo-Bar)\n[explicit](b.md#Custom)\n'), page('docs/b.md', '## Foo Bar\n\n<a id="Custom"></a>\n')];
  // A generated slug is lower case, so only its exact spelling resolves; an explicit id keeps its case.
  assert.deepEqual(docsLinkFindings(files).map(finding => [finding.line, finding.reason]), [[1, 'missing anchor #FOO-BAR in docs/b.md'], [2, 'missing anchor #Foo-Bar in docs/b.md']]);
});

test('link syntax quoted as inline code is not a link, and line numbers survive the strip', () => {
  const files = [page('docs/a.md', 'Run `[guide](missing.md)` to begin.\n\nA span may hold `![shot](gone.png)` too.\n\n[real](gone.md)\n')];
  assert.deepEqual(docsLinkFindings(files).map(finding => [finding.line, finding.reason]), [[5, 'missing target docs/gone.md']]);
});

test('escaped bracket syntax is prose, not a link', () => {
  const files = [page('docs/a.md', 'Write \\[x\\](gone.md) for a literal example.\n\nA closing bracket escapes it too: [y\\](gone.md).\n\n[real](gone.md)\n'), page('docs/b.md', '')];
  assert.deepEqual(docsLinkFindings(files).map(finding => [finding.line, finding.target]), [[5, 'gone.md']]);
});

test('link destinations follow the CommonMark forms', () => {
  const files = [
    page('docs/a.md', ['[query](b.md?plain=1)', '[parens](./a(1).md)', '[angle](<missing name.md>)', '[ref][r]', '', '[r]: ../missing.md'].join('\n')),
    page('docs/a(1).md', ''),
    page('docs/b.md', ''),
  ];
  assert.deepEqual(docsLinkFindings(files).map(finding => [finding.line, finding.target, finding.reason]), [
    [3, 'missing name.md', 'missing target docs/missing name.md'],
    [6, '../missing.md', 'missing target missing.md'],
  ]);
});

test('the index reader keeps a non-ASCII path instead of C-quoting it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'docs-index-'));
  try {
    const quiet = { cwd: directory, stdio: ['ignore', 'ignore', 'ignore'] as const };
    execFileSync('git', ['init', '--quiet'], quiet);
    await writeFile(path.join(directory, '设计.md'), '# 设计\n');
    execFileSync('git', ['add', '设计.md'], quiet);
    assert.deepEqual(trackedFiles(directory), ['设计.md']);
    assert.deepEqual(markdownFiles(trackedFiles(directory)), ['设计.md']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the corpus reader keeps every page across read batches', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'docs-batches-'));
  try {
    const quiet = { cwd: directory, stdio: ['ignore', 'ignore', 'ignore'] as const };
    execFileSync('git', ['init', '--quiet'], quiet);
    const pages = READ_BATCH * 3 + 1;
    for (let index = 0; index < pages; index++) await writeFile(path.join(directory, `page-${String(index).padStart(3, '0')}.md`), `# Page ${index}\n`);
    execFileSync('git', ['add', '.'], quiet);
    const result = await checkDocsLinks(directory);
    assert.equal(result.files, pages);
    assert.deepEqual(result.unresolved, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the Markdown corpus comes from the repository index', () => {
  assert.deepEqual(markdownFiles(['docs/a.md', '.agents/skills/x/SKILL.md', '.github/pull_request_template.md', 'library/design/skip.md', 'studio/src/a.ts']), ['.agents/skills/x/SKILL.md', '.github/pull_request_template.md', 'docs/a.md']);
});

test('links inside fenced code blocks and publish-time placeholders are not validated', () => {
  const content = 'See [docs](../missing.md).\n\n```md\n[example](../also-missing.md)\n```\n\n[details]({{DETAILS_URL}})\n';
  assert.deepEqual(docsLinkFindings([page('docs/a.md', content), page('docs/other.md', '')]).map(finding => finding.line), [1]);
  assert.equal(withoutFences(content).includes('also-missing'), false);
});

test('a fence closes only on a bare run, so a nested example stays inside it', () => {
  const content = '```md\n```js\n[example](nested-missing.md)\n```\n\n[real](gone.md)\n';
  // The info-string line does not close the fence; removing the fence lines instead of blanking them
  // would shift the reported line, so the line count is asserted too.
  assert.equal(withoutFences(content).split('\n').length, content.split('\n').length);
  assert.deepEqual(docsLinkFindings([page('docs/a.md', content)]).map(finding => [finding.line, finding.target]), [[6, 'gone.md']]);
});

test('missing targets, missing anchors, malformed escapes, empty fragments and directory targets are distinguished', () => {
  const files = [page('docs/a.md', [
    '[ok](b.md#real-heading)',
    '[missing file](gone.md)',
    '[missing anchor](b.md#nope)',
    '[directory](sub/)',
    '[explicit anchor](b.md#custom)',
    '[escaped anchor](b.md#%E4%BB%BB%E5%8A%A1)',
    '[top of page](#)',
    '[broken escape](b.md#%zz)',
  ].join('\n')), page('docs/b.md', '## Real heading\n<a id="custom"></a>\n<a id="任务"></a>\n'), page('docs/sub/c.md', '')];
  const findings = docsLinkFindings(files);
  assert.deepEqual(findings.map(finding => [finding.line, finding.reason.startsWith('missing anchor') ? 'anchor' : finding.reason.startsWith('missing target') ? 'target' : 'escape']), [[2, 'target'], [3, 'anchor'], [8, 'escape']]);
});

test('an accepted broken link is keyed by file and target, not by line', () => {
  // Nothing is accepted today, so the mechanism is asserted with a synthetic key.
  assert.deepEqual([...knownBrokenLinks], []);
  const accepted = new Set(['docs/a.md:../missing.md']);
  const citation = 'intro\n\n[citation](../missing.md)\n';
  const kept = partitionFindings(docsLinkFindings([page('docs/a.md', citation), page('docs/b.md', '')]), accepted);
  assert.deepEqual(kept, { unresolved: [], stale: [] });
  // The suppression follows the citation, not the line it sits on.
  const shifted = partitionFindings(docsLinkFindings([page('docs/a.md', 'line\n\nmore\n\n[citation](../missing.md)\n')]), accepted);
  assert.deepEqual(shifted, { unresolved: [], stale: [] });
  // A different link landing on that line must not inherit the exemption.
  const different = partitionFindings(docsLinkFindings([page('docs/a.md', '[other](../other.md)\n')]), accepted);
  assert.deepEqual(different.unresolved.map(finding => finding.target), ['../other.md']);
  assert.deepEqual(different.stale, ['docs/a.md:../missing.md']);
});

test('the tracked Markdown corpus resolves every link and anchor', async () => {
  const result = await checkDocsLinks(root);
  assert.ok(result.files > 500, `expected the corpus, scanned ${result.files} files`);
  assert.deepEqual(result.unresolved, [], 'every relative link and fragment must resolve inside the checkout');
  assert.deepEqual(result.stale, [], 'an accepted broken link that now resolves must be removed from knownBrokenLinks');
});