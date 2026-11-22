import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyTemplate, templatePath, templates } from '../template-library.ts';

test('declared template paths cannot escape the template source or the new project', () => {
  for (const unsafe of ['../escape', 'a/../../b', '/absolute', 'C:/drive', 'bad\\file', 'a//b', './x', '', 'x/./y', 'a/.. /x', 'con.html', 'assets/foo.', 'assets/a:b', null, 7, 'x'.repeat(241)]) {
    assert.throws(() => templatePath(unsafe, 'target'), /模板文件路径无效/, String(unsafe));
  }
  // A longer name that merely starts with a device name, a dot inside a file name and a nested
  // directory stay valid, so the portable rule is not wider than it needs to be.
  for (const safe of ['index.html', 'compositions/scene.html', 'vendor/fonts/inter.css', 'assets/gsap.min.js', 'assets/console-panel.js', 'compositions/dot.name.html']) {
    assert.equal(templatePath(safe, 'target'), safe);
  }
});

test('every shipped template manifest stays inside its own source and target roots', async () => {
  for (const template of templates) {
    const source = path.join('template-library', template.id);
    const manifest = JSON.parse(await readFile(path.join(source, 'registry-item.json'), 'utf8'));
    assert.ok(manifest.files.length, template.id);
    for (const file of manifest.files) {
      const target = templatePath(file.target, 'target');
      const origin = templatePath(file.path, 'path');
      const sourceRoot = path.resolve(source);
      assert.ok(path.resolve(sourceRoot, origin).startsWith(sourceRoot + path.sep), `${template.id}: ${origin}`);
      const projectRoot = path.resolve('/project');
      assert.ok(path.resolve(projectRoot, target).startsWith(projectRoot + path.sep), `${template.id}: ${target}`);
    }
  }
});

test('copyTemplate refuses a tampered manifest before it writes outside the destination', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'template-source-'));
  const destination = await mkdtemp(path.join(tmpdir(), 'template-project-'));
  const source = path.join(sourceRoot, 'template-library', 'decision-tree');
  try {
    await mkdir(source, { recursive: true });
    const manifest = (files: Array<{ path: string; target: string }>) => writeFile(path.join(source, 'registry-item.json'), JSON.stringify({ files }));
    // The entry is refused by the shared guard, so no file is created for it and no read happens.
    for (const target of ['../escape.html', '/absolute.html', 'assets/a:b.html', 'assets/foo.', 'con.html']) {
      await manifest([{ path: 'index.html', target }]);
      await assert.rejects(copyTemplate('decision-tree', destination, sourceRoot, sourceRoot), /模板文件路径无效/, target);
    }
    // A manifest cannot read outside its own template source either.
    await manifest([{ path: '../outside.html', target: 'index.html' }]);
    await assert.rejects(copyTemplate('decision-tree', destination, sourceRoot, sourceRoot), /模板文件路径无效/);
    assert.deepEqual(await readdir(destination), [], 'the destination stays untouched');
    assert.deepEqual((await readdir(sourceRoot)).filter(name => name !== 'template-library'), [], 'nothing escaped beside the destination');
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});
