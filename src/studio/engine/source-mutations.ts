import { posix } from "node:path";
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import {
  dedupeClonedCompositionId,
  findTargetElement,
  nextUniqueId,
  parseSourceDocument,
  patchElementInHtml,
  probeElementInSource,
  probeElementsInSource,
  relinkSplitHalvesInHtml,
  removeElementFromHtml,
  removeElementsFromHtml,
  splitElementInHtml,
  unwrapElementsFromHtml,
  wrapElementsInHtml,
  type ElementRebase,
  type PatchOperation,
  type SourceMutationTarget,
  type UnwrapChildTrack,
} from '@hyperframes/studio-server/source-mutation';
import { findUnsafeDomPatchValues } from '@hyperframes/studio-server/finite-mutation';
import { encodeUrlPath } from '@hyperframes/parsers/asset-paths';
import {
  applyGsapMutationsInMemory,
  bakeGroupTransformIntoMembers,
  copyGsapAnimationsForSelector,
  stripGsapAnimationsForSelector,
} from './gsap-mutations.ts';

export {
  findUnsafeDomPatchValues,
  patchElementInHtml,
  probeElementInSource,
  probeElementsInSource,
  relinkSplitHalvesInHtml,
  removeElementFromHtml,
  removeElementsFromHtml,
  splitElementInHtml,
  unwrapElementsFromHtml,
  wrapElementsInHtml,
  type ElementRebase,
  type PatchOperation,
  type SourceMutationTarget,
  type UnwrapChildTrack,
};

/** Collect all element `id` attributes across a project's HTML files for `ensure-id` deduplication. */
export function collectProjectHtmlIds(htmlByPath: ReadonlyMap<string, string>): Set<string> {
  const ids = new Set<string>();
  const idRe = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  for (const [filePath, html] of htmlByPath) {
    if (!filePath.endsWith('.html') && !filePath.endsWith('.htm')) continue;
    for (const match of html.matchAll(idRe)) {
      const id = (match[1] ?? match[2] ?? '').trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function isStudioFontFaceCss(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192) return false;
  if (!/^@font-face\s*\{[\s\S]*\}$/.test(trimmed)) return false;
  if (/<\/style/i.test(trimmed)) return false;
  const openCount = (trimmed.match(/\{/g) ?? []).length;
  const closeCount = (trimmed.match(/\}/g) ?? []).length;
  return openCount === 1 && closeCount === 1;
}

export function ensureStudioFontFaceCss(html: string, fontFaceCss: string): string {
  if (html.includes(fontFaceCss.trim())) return html;
  const { document } = parseSourceDocument(html);
  const head = document.head;
  if (!head) return html;
  let styleEl = head.querySelector('style[data-hf-studio-fonts="true"]');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-hf-studio-fonts', 'true');
    head.appendChild(styleEl);
  }
  const existing = (styleEl.textContent || '').trim();
  styleEl.textContent = existing ? `${existing}\n${fontFaceCss.trim()}` : fontFaceCss.trim();
  return document.toString();
}

/**
 * Pure in-memory element duplication: clones the target element, assigns a unique ID,
 * dedupes any nested `data-composition-id`, and copies GSAP animations when an ID is present.
 */
export function duplicateElementInHtml(
  source: string,
  target: SourceMutationTarget,
  options: { newId?: string; takenIds?: ReadonlySet<string>; delta?: number } = {},
): { html: string; matched: boolean; clonedId: string | null } {
  const { document, wrappedFragment } = parseSourceDocument(source);
  const el = findTargetElement(document, target);
  if (!el || !el.parentElement) {
    return { html: source, matched: false, clonedId: null };
  }
  const originalId = el.getAttribute('id');
  const clone = el.cloneNode(true) as Element;
  clone.removeAttribute('data-hf-id');
  for (const desc of Array.from(clone.querySelectorAll('[data-hf-id]'))) {
    desc.removeAttribute('data-hf-id');
  }
  dedupeClonedCompositionId(document, clone);

  let clonedId: string | null = null;
  const baseId = options.newId || (originalId ? `${originalId}-copy` : null);
  if (baseId) {
    clonedId = nextUniqueId(document, baseId, options.takenIds);
    clone.setAttribute('id', clonedId);
  } else {
    clone.removeAttribute('id');
  }
  el.after(clone);

  let out = wrappedFragment ? document.body.innerHTML : document.toString();
  if (originalId && clonedId) {
    out = copyGsapAnimationsForSelector(out, `#${originalId}`, `#${clonedId}`, options.delta ?? 0);
  }
  return { html: out, matched: true, clonedId };
}

/**
 * Pure in-memory unwrap + group transform bake + group GSAP cleanup.
 */
export function unwrapGroupWithGsapCleanup(
  source: string,
  groupTarget: SourceMutationTarget,
  childTracks?: UnwrapChildTrack[],
): { html: string; unwrapped: boolean; changed: boolean } {
  const result = unwrapElementsFromHtml(source, groupTarget, childTracks);
  if (!result.unwrapped) {
    return { html: source, unwrapped: false, changed: false };
  }
  let cleaned = result.html;
  if (result.unwrappedGroupId && result.members && result.groupCenter) {
    cleaned = bakeGroupTransformIntoMembers(
      cleaned,
      result.unwrappedGroupId,
      result.members,
      result.groupCenter,
    );
  }
  if (result.unwrappedGroupId) {
    cleaned = stripGsapAnimationsForSelector(cleaned, `#${result.unwrappedGroupId}`);
  }
  return { html: cleaned, unwrapped: true, changed: cleaned !== source };
}

export interface AtomicCutTarget {
  target: SourceMutationTarget;
  originalId?: string;
  splitTime: number;
  elementStart: number;
  elementDuration: number;
  playbackStart?: number;
  playbackRate?: number;
  track?: number;
}

/**
 * Apply all cut targets for a single file atomically in memory (DOM split + GSAP split + relink).
 */
export function applyAtomicCutsToHtml(
  before: string,
  targets: readonly AtomicCutTarget[],
  takenIds?: ReadonlySet<string>,
): { after: string; splitCount: number; skippedSelectors: string[]; rightHalfIds: string[] } {
  let html = before;
  let splitCount = 0;
  const skippedSelectors = new Set<string>();
  const rightHalfIds: string[] = [];
  const usedIds = new Set<string>(takenIds ?? []);

  for (const cut of targets) {
    const { document } = parseSourceDocument(html);
    const el = findTargetElement(document, cut.target);
    if (!el) continue;

    const originalId = cut.originalId || el.getAttribute('id') || undefined;
    const baseNewId = originalId ? `${originalId}-split` : 'clip-split';
    const newId = nextUniqueId(document, baseNewId, usedIds);
    usedIds.add(newId);

    const splitRes = splitElementInHtml(html, cut.target, cut.splitTime, newId, {
      start: cut.elementStart,
      duration: cut.elementDuration,
      ...(cut.playbackStart !== undefined ? { playbackStart: cut.playbackStart } : {}),
      ...(cut.playbackRate !== undefined ? { playbackRate: cut.playbackRate } : {}),
      ...(cut.track !== undefined ? { track: cut.track } : {}),
    });

    if (!splitRes.matched || !splitRes.newId) continue;
    html = splitRes.html;
    splitCount += 1;
    rightHalfIds.push(splitRes.newId);

    if (originalId) {
      const gsapRes = applyGsapMutationsInMemory(html, [
        {
          type: 'split-animations',
          originalId,
          newId: splitRes.newId,
          splitTime: cut.splitTime,
          elementStart: cut.elementStart,
          elementDuration: cut.elementDuration,
        },
      ]);
      if (gsapRes.ok) {
        html = gsapRes.after;
        for (const s of gsapRes.skippedSelectors) skippedSelectors.add(s);
      }
    }
  }

  if (rightHalfIds.length > 0) {
    html = relinkSplitHalvesInHtml(html, rightHalfIds);
  }

  return {
    after: html,
    splitCount,
    skippedSelectors: [...skippedSelectors],
    rightHalfIds,
  };
}

/**
 * Pure in-memory composition insertion (`POST /file-mutations/insert-composition/*`).
 */
export function insertCompositionInMemory(input: {
  parentSource: string;
  childSource: string;
  targetPath: string;
  sourcePath: string;
  start: number;
  desiredTrack: number;
  canvasPosition?: { left: number; top: number };
}): { ok: true; html: string; hostId: string; track: number; duration: number } | { ok: false; status: number; error: string } {
  const childDoc = parseHTMLContent(input.childSource);
  const childRoot = childDoc.querySelector('[data-composition-id]') ??
    childDoc.querySelector('template')?.querySelector('[data-composition-id]');
  if (!childRoot) return { ok: false, status: 400, error: 'Composition source has no root' };
  const compId = childRoot.getAttribute('data-composition-id')?.trim() || 'subcomp';
  const duration = Number.parseFloat(childRoot.getAttribute('data-composition-duration') ?? childRoot.getAttribute('data-duration') ?? '5');
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, status: 400, error: 'Composition source has no valid data-composition-duration' };
  }

  const { document, wrappedFragment } = parseSourceDocument(input.parentSource);
  // linkedom's template element (rather than a detached content clone) owns the serialized children.
  const parentRoot = document.querySelector('[data-composition-id][data-root="true"]') ??
    document.querySelector('[data-composition-id]') ??
    document.querySelector('template')?.querySelector('[data-composition-id]');
  if (!parentRoot) return { ok: false, status: 400, error: 'Target composition has no root element' };
  const dimension = (attribute: string, fallback: number) => {
    const value = Number(childRoot.getAttribute(attribute)) || Number(parentRoot.getAttribute(attribute));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const width = dimension('data-width', 1920), height = dimension('data-height', 1080);
  const taken = new Set(Array.from(parentRoot.querySelectorAll('[id]'), el => el.id));
  taken.add(parentRoot.id);
  const hostId = nextUniqueId(document, compId, taken);
  const start = Math.max(0, Math.round(input.start * 100) / 100);
  const end = start + duration;
  const siblings = Array.from(parentRoot.querySelectorAll<HTMLElement>('[data-track-index]'));
  const occupied = new Set(siblings.filter(el => {
    const from = Number(el.getAttribute('data-start')) || 0;
    return start < from + Number(el.getAttribute('data-duration')) && from < end;
  }).map(el => Number(el.getAttribute('data-track-index'))));
  let track = Math.max(0, Math.round(input.desiredTrack));
  while (occupied.has(track)) track++;
  const at = input.canvasPosition;
  const host = document.createElement('div');
  host.id = hostId;
  host.className = 'clip';
  host.setAttribute('data-composition-id', compId);
  host.setAttribute('data-composition-src', encodeUrlPath(posix.relative(posix.dirname(input.targetPath), input.sourcePath)));
  host.setAttribute('data-start', String(start));
  host.setAttribute('data-duration', String(duration));
  host.setAttribute('data-track-index', String(track));
  host.setAttribute('data-width', String(width));
  host.setAttribute('data-height', String(height));
  const styled = Array.from(parentRoot.querySelectorAll<HTMLElement>('[style]'));
  const zIndex = styled.reduce((max, el) => Math.max(max, Number(el.style.zIndex) || 0), 0) + 1;
  host.setAttribute('style', `position: absolute; left: ${at ? Math.round(at.left - width / 2) : 0}px; top: ${at ? Math.round(at.top - height / 2) : 0}px; width: ${width}px; height: ${height}px; z-index: ${zIndex}`);
  parentRoot.appendChild(host);
  const durationAttr = parentRoot.hasAttribute('data-duration') ? 'data-duration' : 'data-composition-duration';
  if (end > Number(parentRoot.getAttribute(durationAttr))) parentRoot.setAttribute(durationAttr, String(end));
  return { ok: true, html: wrappedFragment ? document.body.innerHTML : document.toString(), hostId, track, duration };
}

/**
 * Pure in-memory reference rewriter for file/folder rename (`PATCH /api/projects/:id/files/*`).
 * Updates raw and URL-encoded relative references across HTML/CSS/JS/JSON text files.
 */
export function rewritePathReferencesInText(
  content: string,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): string {
  const candidates: Array<[string, string]> = [[oldPath, newPath]];
  const encodedOld = encodeUrlPath(oldPath);
  const encodedNew = encodeUrlPath(newPath);
  if (encodedOld !== oldPath) {
    candidates.push([encodedOld, encodedNew]);
  }

  let out = content;
  for (const [from, to] of candidates) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = isDirectory ? '(?=/)' : '(?=["\'`\\s)?#&;\\\\]|$)';
    const re = new RegExp(`(?<=["'\`(=,\\s/]|^)(\\.\\/)?${escaped}${boundary}`, 'g');
    out = out.replace(re, (_match, dotSlash: string | undefined) => `${dotSlash ?? ''}${to}`);
  }
  return out;
}
