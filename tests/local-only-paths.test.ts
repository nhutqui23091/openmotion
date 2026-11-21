import test from 'node:test';
import assert from 'node:assert/strict';
import { localOnlyOffender, localOnlyPaths, trackedFiles } from '../scripts/local-only-paths.ts';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('local-only agent material is rejected in the tracked file set', () => {
  for (const entry of localOnlyPaths) {
    assert.equal(localOnlyOffender([entry]), entry, entry);
    assert.equal(localOnlyOffender(['docs/guide.md', entry + '/SKILL.md']), entry + '/SKILL.md', entry);
  }
  // Project source and any path that merely shares a prefix stay allowed.
  for (const allowed of ['docs/install.md', 'scripts/check.ts', 'AGENTS.md', 'CLAUDE.md', 'humanizer-skills/readme.md', 'AUDIT_PRESS.md']) {
    assert.equal(localOnlyOffender([allowed]), undefined, allowed);
  }
});

test('this checkout tracks no local-only agent material', () => {
  const tracked = trackedFiles(root);
  assert.ok(tracked, 'the repository checkout must expose its tracked file list');
  assert.equal(localOnlyOffender(tracked), undefined);
  assert.ok(tracked!.includes('scripts/check.ts'), 'the tracked list is the real repository index');
});
