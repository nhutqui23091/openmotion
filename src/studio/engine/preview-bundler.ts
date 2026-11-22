import { bridgeDocumentTags, previewBuildBusyScript } from './preview-bridge.ts';
import { createHash } from 'node:crypto';
import {
  AFTER_FONTS_SCRIPT_TYPE,
  CSS_URL_RE,
  RUNTIME_BOOTSTRAP_ATTR,
  addScenePartsManifest,
  assignBundledRuntimeCompositionIds,
  assignMediaRenderIds,
  compileTimingAttrs,
  compositionStyle,
  cssStyleMergeKey,
  dedupeFontFaceRules,
  deferScriptsUntilFonts,
  emitMountedModuleScripts,
  emitRootCompositionVariableStyles,
  emitVariablesByCompScript,
  ensureExternalLinkTag,
  ensureExternalScriptTag,
  extractStandaloneEntryFromIndex,
  headStyleRuns,
  inlineScriptRuns,
  inlineSubCompositions,
  insertBeforeCloseTag,
  insertRuntimeTag,
  isAlwaysAppliedStyle,
  isJavaScriptType,
  isNonRelativeUrl,
  isTemplateEntry,
  parseHTMLContent,
  parseHostVariableValues,
  parsesAsScript,
  prepareFlattenedInnerRoot,
  readDeclaredDefaults,
  stripEmbeddedRuntimeScripts,
  styleElementsFor,
  type CompositionStyle,
} from '@hyperframes/core/compiler';
import {
  escapeInlineScriptSource,
  findStartTags,
  injectTagsAtHeadStart,
  isFullHtmlDocument,
} from '@hyperframes/core/compiler/html-document';
import {
  injectDeterministicFontFaces,
  type InjectDeterministicFontFacesOptions,
} from '@hyperframes/core/fonts/embed';
import {
  GSAP_BASE_URL_META,
  gsapCdnDist,
  motionPathPluginUrl,
  normalizeGsapBaseUrl,
} from '@hyperframes/core/gsap-cdn';
import {
  STUDIO_PREVIEW_CAPTURE_MODE,
  STUDIO_PREVIEW_ERRORS,
  STUDIO_PREVIEW_LAZY_ATTR,
  STUDIO_PREVIEW_MARK_META,
} from '@hyperframes/core/studio-preview-mark';
import {
  decodeCssEscapes,
  decodeWellFormedEscapes,
  decodedUrlPath,
  encodeUrlPath,
  rewriteAssetPath,
  splitUrlSuffix,
} from '@hyperframes/parsers/asset-paths';
import { ensureHfIds } from '@hyperframes/parsers/hf-ids';
import {
  STUDIO_MANUAL_EDITS_PATH,
  createStudioManualEditsRenderBodyScript,
} from '@hyperframes/studio-server/manual-edits-render-script';
import {
  STUDIO_MOTION_PATH,
  createStudioMotionRenderBodyScript,
} from '@hyperframes/studio-server/studio-motion-render-script';
import { repairCodeExtrudeMaterial } from '../../../shared/registry-material-compat.ts';
import {
  normalizeVirtualPath,
  resolveVirtualPath,
  virtualDirname,
  type VirtualProjectReader,
} from '../virtual-project-store.ts';

const PROJECT_SIGNATURE_META = 'hyperframes-project-signature';
const GSAP_FALLBACK_ATTR = 'data-hf-gsap-fallback';
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(["']?)([^)"']+)\1\s*\)|(["'])([^"']+)\3)\s*([^;]*);\s*/g;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const IMPORT_MAP_TYPE = /\btype\s*=\s*["']?importmap["']?(?=[\s/>])/i;

const EARLY_ERRORS_SCRIPT = `<script>(function(){var seen=window.${STUDIO_PREVIEW_ERRORS}=[];addEventListener("error",function(e){seen.push(e.message||String(e))});})();</script>`;

export interface FontCssCachePort {
  getFontCss(hash: string): Promise<string | null>;
  setFontCss(hash: string, css: string, ttlSec?: number): Promise<boolean>;
}

export interface BundlePreviewOptions {
  readonly entryFile?: string;
  /** Origin serving Studio's static bridge, only for a token-enabled document. */
  readonly bridgeOrigin?: string;
  /** Interactive previews can reuse large classic scripts through their authorized asset base. */
  readonly cacheProjectScripts?: boolean;
  readonly runtimeUrl?: string;
  readonly baseHref?: string;
  readonly gsapBaseUrl?: string;
  readonly capture?: boolean;
  readonly variables?: Record<string, unknown> | null;
  readonly fontCssCache?: FontCssCachePort;
  readonly fetchImpl?: typeof fetch;
  /** Skip network Google Fonts injection (useful for deterministic offline unit tests). */
  readonly skipDeterministicFonts?: boolean;
}

function isRelativeUrl(url: string): boolean {
  const trimmed = url.trim();
  return Boolean(trimmed) && !isNonRelativeUrl(trimmed) && !trimmed.startsWith('/');
}

function isProjectLocalMediaUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (isRelativeUrl(trimmed)) return true;
  // Same-origin app paths (e.g. /api/projects/:id/preview/..., /motion-api/..., /assets/...),
  // excluding protocol-relative external URLs (`//cdn.example.com/...`).
  return trimmed.startsWith('/') && !trimmed.startsWith('//');
}

function shouldInjectPreviewMediaCrossOrigin(el: Element): boolean {
  if (Array.from(el.attributes).some((attr) => attr.name.toLowerCase() === 'crossorigin')) {
    return false;
  }
  const urls: string[] = [];
  const directSrc = el.getAttribute('src')?.trim();
  if (directSrc) urls.push(directSrc);
  for (const source of Array.from(el.querySelectorAll('source[src]'))) {
    const src = source.getAttribute('src')?.trim();
    if (src) urls.push(src);
  }
  return urls.length > 0 && urls.every((url) => isProjectLocalMediaUrl(url));
}

/**
 * Cloud preview serves project binary assets via same-origin `/api/projects/:id/preview/*`
 * URLs that `302` redirect to cross-origin presigned S3/R2 URLs (with canonical S3 CORS).
 * Without `crossorigin="anonymous"`, Chromium loads redirected media in no-CORS mode, so
 * Web Audio `createMediaElementSource()` permanently outputs silence even though
 * `el.currentSrc` looks same-origin pre-redirect.
 */
function ensurePreviewMediaCrossOrigin(root: ParentNode): boolean {
  let changed = false;
  for (const el of Array.from(root.querySelectorAll('audio, video'))) {
    if (shouldInjectPreviewMediaCrossOrigin(el)) {
      el.setAttribute('crossorigin', 'anonymous');
      changed = true;
    }
  }
  for (const tpl of Array.from(root.querySelectorAll('template'))) {
    const raw = tpl.innerHTML;
    if (!/<(?:audio|video)\b/i.test(raw)) continue;
    const tplDoc = parseHTMLContent(`<!DOCTYPE html><html><head></head><body>${raw}</body></html>`);
    if (ensurePreviewMediaCrossOrigin(tplDoc.body)) {
      tpl.innerHTML = tplDoc.body.innerHTML;
      changed = true;
    }
  }
  return changed;
}

function cssAttributeSelector(attr: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3c ');
  return `[${attr}="${escaped}"]`;
}

function escapeGsapUrl(url: string): string {
  return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function resolveGsapDistUrl(baseUrl: string): string {
  if (baseUrl.startsWith('/')) {
    return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  }
  return gsapCdnDist(undefined, baseUrl);
}

function gsapScriptTag(file: string, baseUrl: string): string {
  return `<script src="${escapeGsapUrl(resolveGsapDistUrl(baseUrl) + file)}"></script>`;
}

function resolvePreviewGsapBaseUrl(override?: string): string {
  const configured = override ?? process.env.HYPERFRAMES_GSAP_BASE_URL;
  if (typeof configured === 'string') {
    const trimmed = configured.trim();
    if (trimmed.startsWith('/')) {
      if (
        trimmed.includes('?') ||
        trimmed.includes('#') ||
        trimmed.includes('..') ||
        trimmed.includes('\\') ||
        /[\x00-\x1f]/.test(trimmed)
      ) {
        throw new Error('Root-relative GSAP base URL must not contain query, fragment, or traversal.');
      }
      return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    }
  }
  return normalizeGsapBaseUrl(configured);
}

function rebaseCssUrlsVirtual(css: string, cssFileDir: string): string {
  if (!cssFileDir) return css;
  return css.replace(CSS_URL_RE, (full: string, quote: string, urlValue: string) => {
    const decoded = decodeCssEscapes(urlValue);
    if (!decoded || !isRelativeUrl(decoded)) return full;
    const { basePath, suffix } = splitUrlSuffix(decoded);
    if (!basePath) return full;
    const resolved = resolveVirtualPath(cssFileDir, decodeWellFormedEscapes(basePath));
    if (!resolved) return full;
    const rebased = encodeUrlPath(resolved);
    if (rebased === basePath) return full;
    return `url(${quote || ''}${rebased}${suffix}${quote || ''})`;
  });
}

function inlineCssVirtual(
  project: VirtualProjectReader,
  css: string,
  cssFileDir: string,
  activeImports: Set<string>,
): string {
  const comments: string[] = [];
  const stripped = css.replace(CSS_COMMENT_RE, (match) => {
    const idx = comments.length;
    comments.push(match);
    return `/*__hf_c${idx}__*/`;
  });

  const importPlaceholders: string[] = [];
  const withPlaceholders = stripped.replace(
    CSS_IMPORT_RE,
    (full: string, _q1: string, urlPath: string | undefined, _q2: string, barePath: string | undefined, mediaQuery: string) => {
      const importPath = urlPath ?? barePath;
      if (!importPath || !isRelativeUrl(importPath)) return full;
      const resolved = resolveVirtualPath(cssFileDir, decodedUrlPath(importPath));
      if (!resolved) return full;
      if (activeImports.has(resolved)) return '';
      const importedContent = project.readText(resolved);
      if (importedContent === null) return full;
      activeImports.add(resolved);
      const inlined = inlineCssVirtual(project, importedContent, virtualDirname(resolved), activeImports);
      activeImports.delete(resolved);
      const trimmedMedia = (mediaQuery || '').trim();
      const block = trimmedMedia ? `@media ${trimmedMedia} {\n${inlined}\n}\n` : `${inlined}\n`;
      const idx = importPlaceholders.length;
      importPlaceholders.push(block);
      return `/*__hf_import_${idx}__*/`;
    },
  );

  let rebased = rebaseCssUrlsVirtual(withPlaceholders, cssFileDir);
  for (let i = 0; i < comments.length; i++) {
    rebased = rebased.replace(`/*__hf_c${i}__*/`, comments[i]);
  }
  for (let i = 0; i < importPlaceholders.length; i++) {
    rebased = rebased.replace(`/*__hf_import_${i}__*/`, importPlaceholders[i]);
  }
  return rebased;
}

function joinCssHoistingImports(sheets: readonly string[]): string {
  const imports = new Set<string>();
  const parts: string[] = [];
  for (const sheet of sheets) {
    const rest = sheet.trim().replace(CSS_IMPORT_RE, (match) => {
      imports.add(match.trim());
      return '';
    });
    if (rest.trim()) parts.push(rest.trim());
  }
  return [...imports, ...parts].join('\n\n').trim();
}

function joinJsChunks(chunks: readonly string[]): string {
  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => (chunk.endsWith(';') ? chunk : `${chunk}\n;`))
    .join('\n');
}

function withRootPathsRelative(html: string, baseHref: string): string {
  const normalizedBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`;
  return html.replace(
    /\b(src|href|poster|data-composition-src)\s*=\s*(["'])\/(?!\/|api\/|__hyperframes|motion-api\/|design-api\/)([^"']*)\2/gi,
    (_full, attr: string, quote: string, rest: string) => `${attr}=${quote}${normalizedBase}${rest}${quote}`,
  );
}

function withRootImportMap(html: string, base: string): string {
  const ours: Record<string, string> = { '/': base, [base]: base };
  let own: { start: number; end: number; json: string } | null = null;
  for (const at of findStartTags(html, 'script')) {
    const open = /^<script\b[^>]*>/i.exec(html.slice(at));
    if (!open || !IMPORT_MAP_TYPE.test(open[0])) continue;
    const start = at + open[0].length;
    const end = html.toLowerCase().indexOf('</script', start);
    if (end !== -1) {
      own = { start, end, json: html.slice(start, end) };
      break;
    }
  }
  if (!own) {
    return injectTagsAtHeadStart(
      html,
      `<script type="importmap">${JSON.stringify({ imports: ours })}</script>`,
    );
  }
  try {
    const map = JSON.parse(own.json) as {
      imports?: Record<string, string>;
      scopes?: Record<string, Record<string, string>>;
      [k: string]: unknown;
    };
    if (!map || typeof map !== 'object') return html;
    const under = (p: string) => (p.startsWith('/') && !p.startsWith(base) ? `${base}${p.slice(1)}` : p);
    const moved = (entries: Record<string, string> = {}) =>
      Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, under(String(v))]));
    const merged: Record<string, unknown> = { ...map, imports: { ...ours, ...moved(map.imports) } };
    if (map.scopes) {
      merged.scopes = Object.fromEntries(
        Object.entries(map.scopes).map(([scope, entries]) => [under(scope), moved(entries)]),
      );
    }
    return html.slice(0, own.start) + JSON.stringify(merged) + html.slice(own.end);
  } catch {
    return html;
  }
}

function withPreviewBase(html: string, baseHref: string): string {
  const mapped = withRootImportMap(withRootPathsRelative(html, baseHref), baseHref);
  const doc = parseHTMLContent(mapped);
  const base = doc.querySelector('base[href]');
  if (!base) return injectTagsAtHeadStart(mapped, `<base href="${baseHref}">`);
  const href = base.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(baseHref) && !isNonRelativeUrl(href)) {
    base.setAttribute('href', new URL(href, baseHref).href);
    return doc.toString();
  }
  return mapped;
}

function lazyPreviewImages(html: string): string {
  if (!/<!doctype|<html[\s>]/i.test(html)) return html;
  const doc = parseHTMLContent(html);
  const images = [...doc.querySelectorAll('img')];
  const tags = findStartTags(html, 'img');
  if (tags.length !== images.length) return html;

  const startsAfterZero = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (Number(node.getAttribute('data-start')) > 0) return true;
    }
    return false;
  };

  const parts: string[] = [];
  let from = 0;
  images.forEach((img, index) => {
    const hasLoading = Array.from(img.attributes).some((attr) => attr.name.toLowerCase() === 'loading');
    if (hasLoading || !startsAfterZero(img)) return;
    const at = (tags[index] ?? 0) + 4;
    parts.push(html.slice(from, at), ` loading="lazy" ${STUDIO_PREVIEW_LAZY_ATTR}`);
    from = at;
  });
  parts.push(html.slice(from));
  return parts.join('');
}

function injectProjectSignature(html: string, signature: string): string {
  const tag = `<meta name="${PROJECT_SIGNATURE_META}" content="${signature}">`;
  if (html.includes(`name="${PROJECT_SIGNATURE_META}"`)) {
    return html.replace(
      new RegExp(`<meta\\s+name=["']${PROJECT_SIGNATURE_META}["'][^>]*>`, 'i'),
      tag,
    );
  }
  return insertBeforeCloseTag(html, 'head', `${tag}\n`) ?? `${tag}\n${html}`;
}

function injectPreviewVariables(html: string, values: Record<string, unknown>): string {
  const json = JSON.stringify(values).replace(/</g, '\\u003c');
  const tag = `<script data-hf-preview-variables>window.__hfVariables=${json};</script>`;
  for (const pattern of [/<head/i, /<html/i, /^\s*<!doctype/i]) {
    const match = pattern.exec(html);
    if (match) {
      const end = html.indexOf('>', match.index + match[0].length);
      if (end < 0) continue;
      const at = end + 1;
      return html.slice(0, at) + tag + html.slice(at);
    }
  }
  return tag + html;
}

function htmlHasGsapCore(html: string): boolean {
  return /<script\b[^>]*src=["'][^"']*gsap(?:\.min)?\.js/i.test(html) || /\bwindow\.gsap\b/.test(html);
}

function htmlHasCustomEase(html: string): boolean {
  return /<script\b[^>]*src=["'][^"']*CustomEase/i.test(html) || /\bwindow\.CustomEase\b/.test(html);
}

function htmlUsesMotionPath(html: string): boolean {
  return /motionPath\s*[:{]/.test(html);
}

function htmlHasMotionPathPlugin(html: string): boolean {
  return /<script\b[^>]*src=["'][^"']*MotionPathPlugin/i.test(html) || /\bwindow\.MotionPathPlugin\b/.test(html);
}

function gsapCdnFallbackScript(baseUrl: string): string {
  return `<script ${GSAP_FALLBACK_ATTR}>(function(){var cdnBase=${JSON.stringify(resolveGsapDistUrl(baseUrl)).replace(/</g, '\\u003c')};var loaded={};function loadFallback(file){if(loaded[file])return loaded[file];return loaded[file]=new Promise(function(ok,fail){var s=document.createElement("script");s.src=cdnBase+file;s.hfGsapFallback=true;s.onload=ok;s.onerror=fail;document.head.appendChild(s);});}document.addEventListener("error",function(e){var t=e.target;if(!t||t.tagName!=="SCRIPT"||!t.src||t.hfGsapFallback)return;var m=t.src.match(/gsap[^/]*\\/dist\\/(.+\\.js)/);if(m)loadFallback(m[1]).catch(function(){});},true);})();</script>`;
}

function injectGsapCdnFallback(html: string, baseUrl: string): string {
  if (html.includes(GSAP_FALLBACK_ATTR)) return html;
  const script = gsapCdnFallbackScript(baseUrl);
  if (html.includes('<head>')) return html.replace('<head>', `<head>${script}`);
  return injectTagsAtHeadStart(html, script);
}

function injectMotionPathPluginIfNeeded(html: string, baseUrl: string): string {
  if (!htmlUsesMotionPath(html) || htmlHasMotionPathPlugin(html)) return html;
  const pluginUrl = baseUrl.startsWith('/')
    ? `${resolveGsapDistUrl(baseUrl)}MotionPathPlugin.min.js`
    : motionPathPluginUrl(undefined, baseUrl);
  const tag = `<script src="${escapeGsapUrl(pluginUrl)}"></script>`;
  return insertBeforeCloseTag(html, 'head', `${tag}\n`) ?? `${tag}\n${html}`;
}

function injectBodyScript(html: string, scriptBody: string, deferred = true): string {
  const safe = scriptBody.replace(/<\/script/gi, '<\\/script');
  const tag = deferred
    ? `<script type="${AFTER_FONTS_SCRIPT_TYPE}">${safe}</script>`
    : `<script>${safe}</script>`;
  return insertBeforeCloseTag(html, 'body', `${tag}\n`) ?? `${html}\n${tag}`;
}

export function createPreviewBuildBusyHtml(projectId: string, retryAfterSeconds: number): string {
  return injectBodyScript('<!doctype html><html><body>Preview builders are busy.</body></html>',
    previewBuildBusyScript(projectId, retryAfterSeconds), false);
}

/**
 * Create a Redis-cached Google Fonts `fetchImpl` so `injectDeterministicFontFaces` runs with
 * `allowSystemFontCapture: false` and zero local filesystem cache writes.
 */
export function createCachedFontFetch(
  fontCssCache?: FontCssCachePort,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }

    if (fontCssCache && parsed && parsed.origin === 'https://fonts.googleapis.com' && parsed.pathname === '/css2') {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      const ua = headers.get('user-agent') ?? '';
      const cacheHash = createHash('sha256').update(`${url}\n${ua}`).digest('hex').slice(0, 48);
      try {
        const cached = await fontCssCache.getFontCss(cacheHash);
        if (cached !== null) {
          return new Response(cached, {
            status: 200,
            headers: { 'Content-Type': 'text/css; charset=utf-8' },
          });
        }
      } catch {
        // Cache read failure falls through cleanly to upstream fetch.
      }
      const response = await baseFetch(input, init);
      if (response.ok) {
        const body = await response.text();
        if (/@font-face\s*\{/i.test(body)) {
          void fontCssCache.setFontCss(cacheHash, body, 86_400).catch(() => {});
        }
        return new Response(body, {
          status: response.status,
          headers: { 'Content-Type': response.headers.get('content-type') ?? 'text/css; charset=utf-8' },
        });
      }
      return response;
    }

    return baseFetch(input, init);
  };
}

async function applyDeterministicFonts(html: string, options: BundlePreviewOptions): Promise<string> {
  if (options.skipDeterministicFonts) return html;
  const fetchImpl = createCachedFontFetch(options.fontCssCache, options.fetchImpl);
  const embedOptions: InjectDeterministicFontFacesOptions = {
    allowSystemFontCapture: false,
    failClosedFontFetch: false,
    fetchImpl,
  };
  try {
    return await injectDeterministicFontFaces(html, embedOptions);
  } catch {
    return html;
  }
}

function applyStudioPreviewAugmentations(
  html: string,
  project: VirtualProjectReader,
  activeCompositionPath: string,
  options: { capture: boolean; gsapBaseUrl: string; bridgeOrigin?: string; variables?: Record<string, unknown> | null },
): string {
  let out = repairCodeExtrudeMaterial(html);

  // 1. Studio preview marker + early error capture + lazy images
  out = options.capture
    ? injectTagsAtHeadStart(
        out,
        `<meta name="${STUDIO_PREVIEW_MARK_META}" content="${STUDIO_PREVIEW_CAPTURE_MODE}">`,
      )
    : injectTagsAtHeadStart(
        lazyPreviewImages(out),
        `<meta name="${STUDIO_PREVIEW_MARK_META}">${EARLY_ERRORS_SCRIPT}`,
      );

  // The document owns the project data. The same bridge code can be reused
  // across revisions, token renewals, nested compositions and other projects.
  if (options.bridgeOrigin) {
    const versions = Object.fromEntries(project.listFiles().filter(file => /\.html?$/i.test(file.path))
      .map(file => [file.path, file.sha256]));
    const tags = bridgeDocumentTags(options.bridgeOrigin, project.projectId, activeCompositionPath, versions);
    out = injectTagsAtHeadStart(out, tags.preload);
    out = insertBeforeCloseTag(out, 'body', tags.script) ?? out + tags.script;
  }

  // 3. GSAP base URL meta + project signature meta + CDN fallback
  out = injectTagsAtHeadStart(
    out,
    `<meta name="${GSAP_BASE_URL_META}" content="${escapeGsapUrl(options.gsapBaseUrl)}">`,
  );
  out = injectProjectSignature(out, project.revision);
  out = injectGsapCdnFallback(out, options.gsapBaseUrl);

  // 4. Studio motion manifest (.hyperframes/studio-motion.json)
  const motionManifest = project.readText(STUDIO_MOTION_PATH) ?? '';
  if (motionManifest.trim()) {
    const motionScript = createStudioMotionRenderBodyScript(motionManifest, {
      activeCompositionPath,
    });
    if (motionScript) {
      if (!htmlHasGsapCore(out)) {
        out =
          insertBeforeCloseTag(out, 'head', `${gsapScriptTag('gsap.min.js', options.gsapBaseUrl)}\n`) ??
          `${gsapScriptTag('gsap.min.js', options.gsapBaseUrl)}\n${out}`;
      }
      try {
        const parsed = JSON.parse(motionManifest) as { motions?: Array<{ customEase?: unknown }> };
        const hasCustomEase = Array.isArray(parsed.motions) && parsed.motions.some((m) => Boolean(m?.customEase));
        if (hasCustomEase && !htmlHasCustomEase(out)) {
          out =
            insertBeforeCloseTag(out, 'head', `${gsapScriptTag('CustomEase.min.js', options.gsapBaseUrl)}\n`) ?? out;
        }
      } catch {
        // Ignore malformed motion manifest JSON.
      }
      out = injectBodyScript(out, motionScript, true);
    }
  }

  // 5. Studio manual edits manifest (.hyperframes/studio-manual-edits.json)
  const manualEditsManifest = project.readText(STUDIO_MANUAL_EDITS_PATH) ?? '';
  if (manualEditsManifest.trim()) {
    const manualEditsScript = createStudioManualEditsRenderBodyScript(manualEditsManifest, {
      activeCompositionPath,
    });
    if (manualEditsScript) {
      out = injectBodyScript(out, manualEditsScript, true);
    }
  }

  // 6. MotionPath plugin auto-injection when needed
  out = injectMotionPathPluginIfNeeded(out, options.gsapBaseUrl);

  // 7. Preview variable overrides
  if (options.variables && Object.keys(options.variables).length > 0) {
    out = injectPreviewVariables(out, options.variables);
  }

  return out;
}

/**
 * Pure in-memory equivalent of `@hyperframes/core`'s `bundleToSingleHtml` + Studio preview
 * augmentations. Performs ZERO local filesystem reads or writes.
 */
export async function bundlePreviewInMemory(
  project: VirtualProjectReader,
  options: BundlePreviewOptions = {},
): Promise<string | null> {
  const entryFile = normalizeVirtualPath(options.entryFile ?? 'index.html');
  const rawEntry = project.readText(entryFile);
  if (rawEntry === null) return null;

  const runtimeUrl = options.runtimeUrl ?? '/api/runtime.js';
  const baseHref = options.baseHref ?? `/api/projects/${encodeURIComponent(project.projectId)}/preview/`;
  const gsapBaseUrl = resolvePreviewGsapBaseUrl(options.gsapBaseUrl);

  // If entry is a <template> sub-composition, mount it inside index.html shell if present.
  let entryHtml = rawEntry;
  let sourceDir = virtualDirname(entryFile);
  if (isTemplateEntry(rawEntry) && entryFile !== 'index.html') {
    const indexHtml = project.readText('index.html');
    if (indexHtml !== null) {
      const shell = extractStandaloneEntryFromIndex(indexHtml, entryFile, rawEntry);
      if (shell) {
        entryHtml = shell;
        sourceDir = '';
      }
    }
  }

  // Stamp deterministic data-hf-id attributes in memory, then compile timing attributes purely in memory.
  const stampedHtml = ensureHfIds(entryHtml);
  const compiledResult = compileTimingAttrs(stampedHtml);
  const compiledHtml = compiledResult.html;

  // Replace any embedded runtime script with the placeholder tag pointing to `/api/runtime.js`.
  const sanitized = stripEmbeddedRuntimeScripts(compiledHtml);
  const runtimeTag = `<script ${RUNTIME_BOOTSTRAP_ATTR}="1" src="${runtimeUrl}"></script>`;
  const withRuntime = insertRuntimeTag(sanitized, runtimeTag);

  const document = parseHTMLContent(withRuntime);

  // Inline local <link rel="stylesheet"> stylesheets from VirtualProjectReader.
  for (const el of [...document.querySelectorAll('link[rel="stylesheet"]')]) {
    const href = el.getAttribute('href');
    if (!href || !isRelativeUrl(href) || cssStyleMergeKey(el) === undefined) continue;
    if (el.hasAttribute('disabled')) continue;
    const cssPath = resolveVirtualPath(sourceDir, decodedUrlPath(href));
    if (!cssPath) continue;
    const css = project.readText(cssPath);
    if (css === null) continue;
    const style = document.createElement('style');
    for (const name of ['media', 'title']) {
      const val = el.getAttribute(name);
      if (val !== null) style.setAttribute(name, val);
    }
    style.textContent = inlineCssVirtual(project, css, virtualDirname(cssPath), new Set([cssPath]));
    el.replaceWith(style);
  }

  // Inline sub-compositions using pure `@hyperframes/core/compiler` virtual callbacks.
  const trackedHosts = Array.from(document.querySelectorAll('[data-composition-src], [data-composition-id]')).filter(
    (host) => {
      if (host.hasAttribute('data-composition-src')) return true;
      const id = (host.getAttribute('data-hf-original-composition-id') || host.getAttribute('data-composition-id') || '').trim();
      return Boolean(id && document.getElementById(`${id}-template`));
    },
  );
  const hostIdentityMap = assignBundledRuntimeCompositionIds(trackedHosts);
  const subCompHosts = trackedHosts.filter((host) => host.hasAttribute('data-composition-src'));

  const subCompResult = inlineSubCompositions(document, subCompHosts, {
    resolveHtml: (srcPath) => {
      if (!isRelativeUrl(srcPath)) return null;
      const resolved = resolveVirtualPath(sourceDir, decodedUrlPath(srcPath));
      if (!resolved) return null;
      const html = project.readText(resolved);
      return html === null ? null : ensureHfIds(html);
    },
    parseHtml: parseHTMLContent,
    hostIdentityMap,
    rewriteInlineStyles: true,
    assetExists: (assetPath) => {
      const resolved = resolveVirtualPath(sourceDir, decodedUrlPath(assetPath));
      return resolved !== null && project.exists(resolved);
    },
    flattenInnerRoot: prepareFlattenedInnerRoot,
    tagScenes: true,
    readProjectScript: (scriptPath) => {
      if (!isRelativeUrl(scriptPath)) return null;
      const resolved = resolveVirtualPath(sourceDir, decodedUrlPath(scriptPath));
      return resolved ? project.readText(resolved) : null;
    },
    readVariableDefaults: readDeclaredDefaults,
    parseHostVariables: parseHostVariableValues,
    buildScopeSelector: (compId) => cssAttributeSelector('data-composition-id', compId),
    scriptErrorLabel: '[HyperFrames] composition script error:',
    onMissingComposition: () => {},
  });

  // Inline local classic <script src="..."> scripts from VirtualProjectReader.
  for (const el of [...document.querySelectorAll('script[src]')]) {
    const src = el.getAttribute('src');
    if (!src || !isRelativeUrl(src)) continue;
    if ((el.getAttribute('type') || '').trim().toLowerCase() === 'module') continue;
    if (el.getAttribute('integrity')?.trim()) continue;
    const jsPath = resolveVirtualPath(sourceDir, decodedUrlPath(src));
    if (!jsPath) continue;
    const file = project.getFile(jsPath);
    if (options.cacheProjectScripts && isJavaScriptType(el) && file?.isText && file.sizeBytes >= 32 * 1024
      && /\.(?:js|cjs)$/i.test(jsPath) && !el.hasAttribute('async') && !el.hasAttribute('defer')
      && !src.includes('?') && !src.includes('#')) {
      el.setAttribute('src', `${baseHref}${encodeUrlPath(jsPath)}?om-script=${file.sha256}`);
      continue;
    }
    const js = project.readText(jsPath);
    if (js === null) continue;
    el.removeAttribute('src');
    el.textContent = escapeInlineScriptSource(js);
  }

  for (const link of subCompResult.externalLinks) {
    ensureExternalLinkTag(document, link);
  }

  const seenExternalScripts = new Set<string>();
  const scriptRuns: Array<{ scene?: string; chunks: string[] }> = [];
  function appendScript(content: string, scene?: string) {
    const last = scriptRuns.at(-1);
    if (last && last.scene === scene) last.chunks.push(content);
    else scriptRuns.push({ scene, chunks: [content] });
  }
  const sourceOwners = new Map<string, string | undefined>();
  for (const item of subCompResult.scriptItems) {
    if (item.kind === 'inline') continue;
    // A script used by multiple scenes must also work when only one of them is mounted.
    if (!sourceOwners.has(item.src)) sourceOwners.set(item.src, item.scene);
    else if (sourceOwners.get(item.src) !== item.scene) sourceOwners.set(item.src, undefined);
  }
  for (const item of subCompResult.scriptItems) {
    if (item.kind === 'inline') {
      appendScript(item.content, item.scene);
      continue;
    }
    if (item.integrity?.trim() || seenExternalScripts.has(item.src)) {
      if (item.integrity?.trim()) ensureExternalScriptTag(document, item.src, item);
      seenExternalScripts.add(item.src);
      continue;
    }
    seenExternalScripts.add(item.src);
    if (isRelativeUrl(item.src) && item.type !== 'module') {
      const resolved = resolveVirtualPath(sourceDir, decodedUrlPath(item.src));
      const js = resolved ? project.readText(resolved) : null;
      if (js !== null) {
        appendScript(js, sourceOwners.get(item.src));
        continue;
      }
    }
    ensureExternalScriptTag(document, item.src, item);
  }

  emitVariablesByCompScript(document, subCompResult.variablesByComp);

  const compStyles: CompositionStyle[] = subCompResult.styles;
  if (compStyles.length > 0) {
    for (const styleEl of styleElementsFor(document, compStyles, joinCssHoistingImports)) {
      document.head.appendChild(styleEl);
    }
  }

  for (const { scene, chunks } of scriptRuns) {
    const joined = joinJsChunks(chunks);
    const pieces = parsesAsScript(joined) ? [joined] : chunks;
    for (const piece of pieces) {
      const script = document.createElement('script');
      if (scene) script.setAttribute('data-hf-scene', scene);
      script.textContent = escapeInlineScriptSource(piece);
      document.body.appendChild(script);
    }
  }

  emitMountedModuleScripts(document, subCompResult.importMaps, subCompResult.moduleScripts);
  emitRootCompositionVariableStyles(document, subCompResult.variablesByComp);

  // Coalesce head styles & dedupe @font-face rules
  const allHeadStyles = [...document.querySelectorAll('head style')];
  for (const run of allHeadStyles.length > 1 ? headStyleRuns(allHeadStyles, () => false) : []) {
    const merged = joinCssHoistingImports(run.map((el) => el.textContent || ''));
    if (!merged) continue;
    run[0].textContent = merged;
    for (const el of run.slice(1)) el.remove();
  }

  // Coalesce inline body scripts safely
  const isPinned = (el: Element) => el.hasAttribute(RUNTIME_BOOTSTRAP_ATTR) || el.hasAttribute('data-hf-scene');
  for (const { members, anchor } of inlineScriptRuns([...document.querySelectorAll('body script')], isPinned)) {
    const mergedJs = joinJsChunks(members.map((el) => el.textContent || ''));
    if (!mergedJs || !parsesAsScript(mergedJs)) continue;
    for (const el of members) el.remove();
    const inlineScript = document.createElement('script');
    inlineScript.textContent = escapeInlineScriptSource(mergedJs);
    if (anchor) anchor.before(inlineScript);
    else document.body.appendChild(inlineScript);
  }

  // Defer user scripts until fonts are ready
  deferScriptsUntilFonts(document, (el) => el.hasAttribute(RUNTIME_BOOTSTRAP_ATTR));

  // Subpixel text-rendering parity rule
  if (document.head && !document.querySelector('style[data-hyperframes-text-rendering]')) {
    const trStyle = document.createElement('style');
    trStyle.setAttribute('data-hyperframes-text-rendering', 'true');
    trStyle.textContent = 'html,body,*{text-rendering:geometricPrecision}';
    document.head.insertBefore(trStyle, document.head.firstChild);
  }

  // Dedupe @font-face rules
  const liveStyles = [...document.querySelectorAll('style')].filter((el) => isAlwaysAppliedStyle(el));
  const deduped = dedupeFontFaceRules(liveStyles.map((el) => el.textContent || ''));
  liveStyles.forEach((el, index) => {
    el.textContent = deduped[index] ?? '';
  });

  // Assign deterministic media render IDs and opt project-local media into CORS for S3 302 redirects
  assignMediaRenderIds(document);
  ensurePreviewMediaCrossOrigin(document);

  let html = document.toString();
  html = withPreviewBase(html, baseHref);
  html = await applyDeterministicFonts(html, options);
  html = ensureHfIds(html);
  html = applyStudioPreviewAugmentations(html, project, entryFile, {
    capture: Boolean(options.capture),
    gsapBaseUrl,
    variables: options.variables,
    bridgeOrigin: options.bridgeOrigin,
  });
  html = addScenePartsManifest(html, [`meta[name="${PROJECT_SIGNATURE_META}"]`]);
  return html;
}

function rewriteSubCompDomPaths(doc: Document, compPath: string, project: VirtualProjectReader): void {
  const exists = (candidate: string) => project.exists(candidate);
  for (const el of [...doc.querySelectorAll('[src], [href], [poster]')]) {
    for (const attr of ['src', 'href', 'poster']) {
      const value = el.getAttribute(attr);
      if (!value || !isRelativeUrl(value)) continue;
      el.setAttribute(attr, rewriteAssetPath(compPath, value, exists));
    }
  }
  for (const styleEl of [...doc.querySelectorAll('style')]) {
    styleEl.textContent = rebaseCssUrlsVirtual(styleEl.textContent || '', virtualDirname(compPath));
  }
}

/**
 * Pure in-memory standalone sub-composition HTML builder for `GET /api/projects/:id/preview/comp/*`.
 */
export async function buildSubCompositionHtmlInMemory(
  project: VirtualProjectReader,
  compPathInput: string,
  options: BundlePreviewOptions = {},
): Promise<string | null> {
  const compPath = normalizeVirtualPath(compPathInput);
  const rawComp = project.readText(compPath);
  if (rawComp === null) return null;

  const runtimeUrl = options.runtimeUrl ?? '/api/runtime.js';
  const baseHref = options.baseHref ?? `/api/projects/${encodeURIComponent(project.projectId)}/preview/`;
  const gsapBaseUrl = resolvePreviewGsapBaseUrl(options.gsapBaseUrl);
  const stamped = ensureHfIds(rawComp);

  let compHeadContent = '';
  let rewrittenContent = stamped;
  let htmlAttrs = '';
  let bodyAttrs = '';

  const templateMatch = /<template\b[^>]*>([\s\S]*?)<\/template>/i.exec(stamped);
  if (templateMatch) {
    const innerDoc = parseHTMLContent(`<!DOCTYPE html><html><head></head><body>${templateMatch[1]}</body></html>`);
    rewriteSubCompDomPaths(innerDoc, compPath, project);
    const tplIdMatch = /<template\b[^>]*\bid=["']([^"']+)-template["']/i.exec(stamped);
    const compRoot = innerDoc.body.querySelector('[data-composition-id]');
    if (tplIdMatch && !compRoot && innerDoc.body.firstElementChild) {
      innerDoc.body.firstElementChild.setAttribute('data-composition-id', tplIdMatch[1]);
    }
    rewrittenContent = innerDoc.body.innerHTML || templateMatch[1];
  } else if (isFullHtmlDocument(stamped)) {
    const fullDoc = parseHTMLContent(stamped);
    rewriteSubCompDomPaths(fullDoc, compPath, project);
    compHeadContent = fullDoc.head?.innerHTML ?? '';
    rewrittenContent = fullDoc.body?.innerHTML ?? '';
    htmlAttrs = Array.from(fullDoc.documentElement?.attributes ?? [])
      .map((a) => `${a.name}="${a.value.replace(/"/g, '&quot;')}"`)
      .join(' ');
    bodyAttrs = Array.from(fullDoc.body?.attributes ?? [])
      .map((a) => `${a.name}="${a.value.replace(/"/g, '&quot;')}"`)
      .join(' ');
  } else {
    const fragDoc = parseHTMLContent(`<!DOCTYPE html><html><head></head><body>${stamped}</body></html>`);
    rewriteSubCompDomPaths(fragDoc, compPath, project);
    rewrittenContent = fragDoc.body.innerHTML || stamped;
  }

  rewrittenContent = stripEmbeddedRuntimeScripts(rewrittenContent);
  const scriptsDoc = parseHTMLContent(`<!DOCTYPE html><html><head></head><body>${rewrittenContent}</body></html>`);
  deferScriptsUntilFonts(scriptsDoc);
  ensurePreviewMediaCrossOrigin(scriptsDoc.body);
  const rootComp = scriptsDoc.body.querySelector('[data-composition-id]');
  if (rootComp && !rootComp.getAttribute('data-composition-file')) {
    rootComp.setAttribute('data-composition-file', compPath);
  }
  rewrittenContent = scriptsDoc.body.innerHTML;

  const indexHtml = project.readText('index.html') ?? '';
  let headContent = indexHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  if (compHeadContent) headContent += `\n${compHeadContent}`;
  headContent = stripEmbeddedRuntimeScripts(headContent);
  headContent += `\n<script ${RUNTIME_BOOTSTRAP_ATTR}="1" src="${runtimeUrl}"></script>`;
  if (!htmlHasGsapCore(headContent)) {
    headContent += `\n${gsapScriptTag('gsap.min.js', gsapBaseUrl)}`;
  }

  const htmlOpen = htmlAttrs ? `<html ${htmlAttrs}>` : '<html>';
  const bodyOpen = bodyAttrs ? `<body ${bodyAttrs}>` : '<body>';
  let html = `<!DOCTYPE html>\n${htmlOpen}\n<head>\n${headContent}\n</head>\n${bodyOpen}\n<script>window.__timelines=window.__timelines||{};</script>\n${rewrittenContent}\n</body>\n</html>`;

  html = withPreviewBase(html, baseHref);
  html = await applyDeterministicFonts(html, options);
  html = ensureHfIds(html);
  html = applyStudioPreviewAugmentations(html, project, compPath, {
    capture: Boolean(options.capture),
    gsapBaseUrl,
    variables: options.variables,
    bridgeOrigin: options.bridgeOrigin,
  });
  return html;
}

export function previewEtag(
  signature: string,
  options: { compPath?: string; gsapBaseUrl?: string; rawVariables?: string; capture?: boolean } = {},
): string {
  const gsapSalt = createHash('sha1')
    .update(resolvePreviewGsapBaseUrl(options.gsapBaseUrl))
    .digest('hex')
    .slice(0, 12);
  const varsSalt = options.rawVariables
    ? `:vars:${createHash('sha1').update(options.rawVariables).digest('hex').slice(0, 12)}`
    : '';
  const captureSalt = options.capture ? ':capture' : '';
  if (options.compPath) {
    const pathHash = createHash('sha1').update(options.compPath).digest('hex');
    return `"comp:v3:${pathHash}:${signature}:gsap:${gsapSalt}${varsSalt}${captureSalt}"`;
  }
  return `"preview:v2:${signature}:gsap:${gsapSalt}${varsSalt}${captureSalt}"`;
}
