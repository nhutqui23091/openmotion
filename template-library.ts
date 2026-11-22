import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeProjectConfig, pluginRoot } from './hyperframes.ts';
import { portableNameProblem } from './shared/project-name.ts';

export const welcomeTemplateId = 'openmotion-welcome';
// Brand resources and third-party dependencies retain their maintained sources.
// Materialized projects receive private, portable copies they can edit freely.
export const welcomeSharedAssets = [
  ['packages/design-system/brand/loading-mark.svg', 'assets/brand-mark.svg'],
  ['packages/design-system/fonts/AlbertSans-VariableFont_wght.ttf', 'assets/fonts/AlbertSans.ttf'],
  ['packages/design-system/fonts/Albert-Sans-OFL.txt', 'assets/fonts/Albert-Sans-OFL.txt'],
  ['packages/design-system/opendesign-logo-SOURCE.md', 'assets/brand-NOTICE.md'],
  ['library/skills/openmotion-design-remix/vendor/fonts/libre-baskerville-f5bc4341f15d.ttf', 'assets/fonts/serif.ttf'],
  ['library/skills/openmotion-design-remix/vendor/fonts/libre-baskerville-OFL.txt', 'assets/fonts/Libre-Baskerville-OFL.txt'],
  ['library/skills/openmotion-design-remix/vendor/three-0.147.0/build/three.min.js', 'assets/three.min.js'],
  ['library/skills/openmotion-design-remix/vendor/three-0.147.0/LICENSE', 'assets/three-LICENSE.txt'],
] as const;

export const templates = [
  { id: 'product-promo', title: 'Product Promo', label: '产品宣传', description: '从图标开场到多人协作，查看多场景动画与字幕编排。', duration: 20, width: 1920, height: 1080, posterTime: 7 },
  { id: 'nyt-graph', title: 'NYT Graph', label: '数据叙事', description: '报刊风格的动态图表，查看数据、标注与图形的节奏。', duration: 15, width: 1920, height: 1080, posterTime: 9 },
  { id: 'decision-tree', title: 'Decision Tree', label: '流程动画', description: '逐步展开的决策树，查看节点、连线与分支动画。', duration: 10, width: 1920, height: 1080, posterTime: 7 },
].map(template => ({ ...template, author: 'Hyperframes', poster: `/api/templates/${template.id}/poster`, source: `https://github.com/heygen-com/hyperframes/tree/3baf81f9a92615507f76fe8de33e489034ee77ec/registry/examples/${template.id}` })).concat([
  { id: welcomeTemplateId, title: 'OpenMotion Welcome', label: 'Official welcome', description: 'An editable brand welcome with kinetic typography, a motion gallery and a three-dimensional closing mark.', duration: 37.3, width: 1920, height: 1080, posterTime: 3.8,
    author: 'OpenMotion', poster: `/api/templates/${welcomeTemplateId}/poster`, source: 'https://github.com/nexu-io/openmotion/tree/main/template-library/openmotion-welcome' },
]);

export function findTemplate(id: string) {
  const template = templates.find(item => item.id === id);
  if (!template) throw new Error('模板不存在');
  return template;
}

/** A manifest path may only name a relative file inside the template source or the new project. */
export function templatePath(value: unknown, field: string) {
  // Only platform-independent rules apply here. A POSIX root and a drive prefix (a colon at all) are
  // rejected, and so is every segment the shared portable-name rule refuses, because Win32
  // canonicalizes a trailing dot or space away and cannot materialize a reserved device name. The
  // answer therefore cannot change with the host platform.
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\:\x00-\x1f\x7f]/.test(value)
    || path.posix.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')
    || portableNameProblem(value)) throw new Error('模板文件路径无效:' + field);
  return value;
}

/**
 * Materialize a shipped template into `directory`. `sourceRoot` is the checkout or installed
 * application that holds `template-library/`, and it defaults to the running application; naming it
 * lets a caller exercise a tampered manifest against a staged source instead of the shipped one.
 */
export async function copyTemplate(id: string, directory: string, runtimeRoot: string, sourceRoot = pluginRoot) {
  findTemplate(id);
  const source = path.join(sourceRoot, 'template-library', id);
  const manifest = JSON.parse(await readFile(path.join(source, 'registry-item.json'), 'utf8'));
  for (const file of manifest.files) {
    // The shipped manifests are trusted content, but the same containment the other catalogue readers
    // enforce keeps a future manifest from writing outside the new project or reading outside the source.
    // Compare resolved paths: the destination can arrive with a trailing separator, which path.join
    // collapses, so a raw prefix test would reject every legitimate target in that case.
    const projectRoot = path.resolve(directory);
    const resolvedSource = path.resolve(source);
    const target = path.join(directory, templatePath(file.target, 'target'));
    if (!path.resolve(target).startsWith(projectRoot + path.sep)) throw new Error('模板文件路径无效:target');
    const origin = path.join(source, templatePath(file.path, 'path'));
    if (!path.resolve(origin).startsWith(resolvedSource + path.sep)) throw new Error('模板文件路径无效:path');
    await mkdir(path.dirname(target), { recursive: true });
    if (target.endsWith('.html')) {
      const relative = path.relative(path.dirname(target), path.join(directory, 'assets/gsap.min.js')).split(path.sep).join('/');
      const html = (await readFile(origin, 'utf8')).replaceAll('https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js', relative);
      await writeFile(target, html);
    } else await copyFile(origin, target);
  }
  if (id === welcomeTemplateId) {
    for (const [sourcePath, targetPath] of welcomeSharedAssets) {
      const target = path.join(directory, targetPath);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(sourceRoot, sourcePath), target);
    }
  }
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await copyFile(path.join(runtimeRoot, 'node_modules/gsap/dist/gsap.min.js'), path.join(directory, 'assets/gsap.min.js'));
  await cp(path.join(sourceRoot, 'template-library/LICENSE'), path.join(directory, 'LICENSE'));
  if (id !== welcomeTemplateId) await cp(path.join(sourceRoot, 'template-library/NOTICE.md'), path.join(directory, 'NOTICE.md'));
  await writeFile(path.join(directory, 'hyperframes.json'), JSON.stringify(nativeProjectConfig, null, 2));
}
