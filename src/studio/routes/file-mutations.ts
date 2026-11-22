import { readCompositionDependencies } from '../engine/composition-dependencies.ts';
import { randomUUID } from 'node:crypto';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { CloudError, isCloudError } from '../../contracts/errors.ts';
import { asInsert, asUpdate } from '../../db/helpers.ts';
import { jobs } from '../../db/schema/jobs.ts';
import { normalizeSafeProjectPath, type ProjectFileOp } from '../../services/project-files-service.ts';
import {
  extractWildcardPath,
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import {
  applyAtomicCutsToHtml,
  collectProjectHtmlIds,
  duplicateElementInHtml,
  ensureStudioFontFaceCss,
  findUnsafeDomPatchValues,
  insertCompositionInMemory,
  isStudioFontFaceCss,
  patchElementInHtml,
  probeElementInSource,
  probeElementsInSource,
  relinkSplitHalvesInHtml,
  removeElementFromHtml,
  removeElementsFromHtml,
  splitElementInHtml,
  unwrapGroupWithGsapCleanup,
  wrapElementsInHtml,
  type AtomicCutTarget,
  type ElementRebase,
  type PatchOperation,
  type SourceMutationTarget,
  type UnwrapChildTrack,
} from '../engine/source-mutations.ts';
import { createWriteToken, fileContentVersion, formatVersionFromSha256, sha256Hex } from '../etag.ts';

function readTargetPath(url: string, marker: string, fallback = 'index.html'): string {
  const raw = extractWildcardPath(url, marker);
  return normalizeSafeProjectPath(raw || fallback, true);
}

export function createStudioFileMutationsRoutes(
  deps: DisklessStudioDeps,
): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // POST /api/projects/:id/file-mutations/patch-element/* — Patch a single DOM element in HTML.
  app.post('/api/projects/:id/file-mutations/patch-element/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/patch-element/');
    const body = (await c.req.json().catch(() => null)) as {
      target?: SourceMutationTarget;
      operations?: PatchOperation[];
      ops?: PatchOperation[];
      fontFaceCss?: string;
    } | null;
    const operations = body?.operations ?? body?.ops;
    if (!body?.target || !Array.isArray(operations)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain a target and an operations array.', {
        status: 400,
        applied: false,
      });
    }

    const unsafe = findUnsafeDomPatchValues(operations);
    if (unsafe.length > 0) {
      return c.json({ error: 'Non-finite or unsafe DOM patch values', unsafe }, 400);
    }

    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const currentText = virtual.readText(filePath);
    if (currentText === null) {
      return c.json({ error: 'Target file not found', path: filePath }, 404);
    }

    const htmlByPath = new Map<string, string>();
    for (const f of virtual.listFiles()) {
      if (f.isText && (f.path.endsWith('.html') || f.path.endsWith('.htm'))) {
        const text = virtual.readText(f.path);
        if (text !== null) htmlByPath.set(f.path, text);
      }
    }
    const takenIds = collectProjectHtmlIds(htmlByPath);
    const patched = patchElementInHtml(currentText, body.target, operations, takenIds);
    let nextHtml = patched.html;

    if (body.fontFaceCss !== undefined) {
      if (!isStudioFontFaceCss(body.fontFaceCss)) {
        return c.json({ error: 'Invalid studio @font-face CSS block' }, 400);
      }
      nextHtml = ensureStudioFontFaceCss(nextHtml, body.fontFaceCss);
    }

    const changed = nextHtml !== currentText;
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = formatVersionFromSha256(sha256Hex(nextHtml));

    if (changed) {
      const ifMatch = c.req.header('if-match') ?? formatVersionFromSha256(sha256Hex(currentText));
      try {
        const committed = await deps.files.commitChanges(auth, {
          projectId,
          ops: [{ op: 'upsert_text', path: filePath, content: nextHtml, stampHfIds: true }],
          filePreconditions: [{ path: filePath, ifMatch }],
          source: 'studio',
          summary: `Patched element in ${filePath}`,
          writeToken,
        });
        version = committed.versionsByPath[filePath] ?? version;
      } catch (error) {
        if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
          return c.json({ error: 'file conflict', code: 'VERSION_MISMATCH', path: filePath }, 409);
        }
        throw error;
      }
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      changed,
      matched: patched.matched,
      elementId: patched.elementId ?? null,
      content: nextHtml,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/patch-element-batches — Multi-file atomic DOM patch batch.
  // Exact shape expected by studio/src/components/inspector/useDomEditCommitsHelpers.ts.
  app.post('/api/projects/:id/file-mutations/patch-element-batches', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      batches?: Array<{
        sourceFile?: string;
        path?: string;
        ifMatch?: string;
        patches?: Array<{ target: SourceMutationTarget; operations: PatchOperation[] }>;
        edits?: Array<{ target: SourceMutationTarget; ops: PatchOperation[]; fontFaceCss?: string }>;
        target?: SourceMutationTarget;
        ops?: PatchOperation[];
        fontFaceCss?: string;
      }>;
    } | null;

    if (!body || !Array.isArray(body.batches)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "batches" array.', {
        status: 400,
        applied: false,
      });
    }

    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const htmlByPath = new Map<string, string>();
    for (const f of virtual.listFiles()) {
      if (f.isText && (f.path.endsWith('.html') || f.path.endsWith('.htm'))) {
        const t = virtual.readText(f.path);
        if (t !== null) htmlByPath.set(f.path, t);
      }
    }
    const takenIds = collectProjectHtmlIds(htmlByPath);

    const fileResults: Array<{
      sourceFile: string;
      changed: boolean;
      matched: boolean[];
      before: string;
      after: string;
    }> = [];
    const commitOps: ProjectFileOp[] = [];
    const preconditions: Array<{ path: string; ifMatch: string }> = [];

    const seenFiles = new Set<string>();
    for (const batch of body.batches) {
      const sourceFile = normalizeSafeProjectPath(batch.sourceFile ?? batch.path ?? 'index.html', true);
      if (seenFiles.has(sourceFile)) return c.json({ error: 'Duplicate batch file', durable: false }, 400);
      seenFiles.add(sourceFile);
      const before = virtual.readText(sourceFile);
      if (before === null) {
        return c.json({ error: `Target file not found: ${sourceFile}`, durable: false }, 404);
      }

      const currentVersion = formatVersionFromSha256(sha256Hex(before));
      if (batch.ifMatch !== undefined && batch.ifMatch !== currentVersion) {
        return c.json({ error: 'file conflict', code: 'VERSION_MISMATCH', durable: false }, 409);
      }
      if (batch.patches !== undefined && !Array.isArray(batch.patches)) {
        return c.json({ error: 'Invalid patches', durable: false }, 400);
      }
      const edits = batch.patches?.map(patch => ({
        target: patch?.target, ops: patch?.operations, fontFaceCss: undefined,
      })) ?? batch.edits ?? (batch.target && batch.ops
        ? [{ target: batch.target, ops: batch.ops, fontFaceCss: batch.fontFaceCss }]
        : []);
      if (!edits.length) return c.json({ error: 'No patches supplied', durable: false }, 400);

      let after = before;
      const matched: boolean[] = [];

      for (const edit of edits) {
        if (!edit?.target || !Array.isArray(edit.ops)) return c.json({ error: 'Invalid patch', durable: false }, 400);
        const unsafe = findUnsafeDomPatchValues(edit.ops);
        if (unsafe.length > 0) {
          return c.json({ error: 'Non-finite or unsafe DOM patch values', unsafe, durable: false }, 400);
        }
        const patched = patchElementInHtml(after, edit.target, edit.ops, takenIds);
        matched.push(patched.matched);
        if (patched.elementId) takenIds.add(patched.elementId);
        after = patched.html;
        if (edit.fontFaceCss !== undefined) {
          if (!isStudioFontFaceCss(edit.fontFaceCss)) {
            return c.json({ error: 'Invalid studio @font-face CSS block', durable: false }, 400);
          }
          after = ensureStudioFontFaceCss(after, edit.fontFaceCss);
        }
      }

      const changed = after !== before;
      fileResults.push({ sourceFile, changed, matched, before, after });
      if (changed) {
        commitOps.push({ op: 'upsert_text', path: sourceFile, content: after, stampHfIds: true });
        preconditions.push({ path: sourceFile, ifMatch: currentVersion });
      }
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const durable = fileResults.every(file => file.matched.every(Boolean));
    let revision = virtual.revision;

    if (durable && commitOps.length > 0) {
      try {
        const committed = await deps.files.commitChanges(auth, {
          projectId,
          ops: commitOps,
          filePreconditions: preconditions,
          source: 'studio',
          summary: `Patched ${commitOps.length} composition file${commitOps.length === 1 ? '' : 's'}`,
          writeToken,
        });
        revision = committed.revision;
      } catch (error) {
        if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
          return c.json({ error: 'file conflict', code: 'VERSION_MISMATCH', durable: false }, 409);
        }
        throw error;
      }
    }

    return c.json({
      ok: true,
      durable,
      revision,
      writeToken,
      files: fileResults.map((file, i) => ({
        ...file,
        ...(!durable && { after: file.before, changed: false }),
        matched: body.batches![i]!.patches ? file.matched : file.matched.some(Boolean),
      })),
    });
  });

  // POST /api/projects/:id/file-mutations/patch-elements-batch/* — Multi-edit single-file patch.
  app.post('/api/projects/:id/file-mutations/patch-elements-batch/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/patch-elements-batch/');
    const body = (await c.req.json().catch(() => null)) as {
      edits?: Array<{ target: SourceMutationTarget; ops: PatchOperation[]; fontFaceCss?: string }>;
    } | null;

    if (!body || !Array.isArray(body.edits)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "edits" array.', {
        status: 400,
        applied: false,
      });
    }

    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const before = virtual.readText(filePath);
    if (before === null) {
      return c.json({ error: 'Target file not found', path: filePath }, 404);
    }

    let after = before;
    let matchedCount = 0;
    const elementIds: Array<string | null> = [];

    for (const edit of body.edits) {
      const unsafe = findUnsafeDomPatchValues(edit.ops);
      if (unsafe.length > 0) {
        return c.json({ error: 'Non-finite or unsafe DOM patch values', unsafe }, 400);
      }
      const res = patchElementInHtml(after, edit.target, edit.ops);
      if (res.matched) matchedCount += 1;
      elementIds.push(res.elementId ?? null);
      after = res.html;
      if (edit.fontFaceCss && isStudioFontFaceCss(edit.fontFaceCss)) {
        after = ensureStudioFontFaceCss(after, edit.fontFaceCss);
      }
    }

    const changed = after !== before;
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = formatVersionFromSha256(sha256Hex(after));

    if (changed) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: after, stampHfIds: true }],
        filePreconditions: [{ path: filePath, ifMatch: formatVersionFromSha256(sha256Hex(before)) }],
        source: 'studio',
        summary: `Batch patched ${matchedCount} elements in ${filePath}`,
        writeToken,
      });
      version = committed.versionsByPath[filePath] ?? version;
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      changed,
      matchedCount,
      elementIds,
      content: after,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/remove-element/* — Remove a single element.
  app.post('/api/projects/:id/file-mutations/remove-element/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/remove-element/');
    const body = (await c.req.json().catch(() => null)) as { target?: SourceMutationTarget } | null;
    if (!body?.target) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "target".', { status: 400, applied: false });
    }

    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) return c.json({ error: 'Target file not found', path: filePath }, 404);

    const nextHtml = removeElementFromHtml(current.content, body.target);
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = current.version;
    const removed = nextHtml !== current.content;

    if (removed) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: nextHtml, stampHfIds: true }],
        filePreconditions: [{ path: filePath, ifMatch: current.version }],
        source: 'studio',
        summary: `Removed element from ${filePath}`,
        writeToken,
      });
      version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(nextHtml));
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      removed,
      changed: removed,
      content: nextHtml,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/remove-elements/* — Remove multiple elements atomically.
  app.post('/api/projects/:id/file-mutations/remove-elements/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/remove-elements/');
    const body = (await c.req.json().catch(() => null)) as { targets?: SourceMutationTarget[] } | null;
    if (!body || !Array.isArray(body.targets)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "targets" array.', { status: 400, applied: false });
    }

    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) return c.json({ error: 'Target file not found', path: filePath }, 404);

    const shownVersion = c.req.header('if-match');
    if (shownVersion !== undefined && shownVersion !== current.version)
      return c.json({ error: 'file conflict', code: 'VERSION_MISMATCH', durable: false }, 409);

    const nextHtml = removeElementsFromHtml(current.content, body.targets);
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = current.version;
    const changed = nextHtml !== current.content;
    const removedCount = changed ? body.targets.length : 0;

    if (changed) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: nextHtml, stampHfIds: true }],
        filePreconditions: [{ path: filePath, ifMatch: current.version }],
        source: 'studio',
        summary: `Removed ${removedCount} elements from ${filePath}`,
        writeToken,
      });
      version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(nextHtml));
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      removedCount,
      changed,
      content: nextHtml,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/split-element/* — Split a single element at `splitTime`.
  app.post('/api/projects/:id/file-mutations/split-element/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/split-element/');
    const body = (await c.req.json().catch(() => null)) as {
      target?: SourceMutationTarget;
      splitTime?: number;
      newId?: string;
      elementStart?: number;
      elementDuration?: number;
      playbackStart?: number;
      playbackRate?: number;
      track?: number;
    } | null;

    if (!body?.target || typeof body.splitTime !== 'number' || !Number.isFinite(body.splitTime)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "target" and numeric "splitTime".', {
        status: 400,
        applied: false,
      });
    }

    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) return c.json({ error: 'Target file not found', path: filePath }, 404);

    const splitRes = splitElementInHtml(
      current.content,
      body.target,
      body.splitTime,
      body.newId ?? `split-${randomUUID().slice(0, 6)}`,
      body.elementStart !== undefined && body.elementDuration !== undefined
        ? {
            start: body.elementStart,
            duration: body.elementDuration,
            ...(body.playbackStart !== undefined ? { playbackStart: body.playbackStart } : {}),
            ...(body.playbackRate !== undefined ? { playbackRate: body.playbackRate } : {}),
            ...(body.track !== undefined ? { track: body.track } : {}),
          }
        : undefined,
    );

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = current.version;
    if (splitRes.matched && splitRes.html !== current.content) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: splitRes.html, stampHfIds: true }],
        filePreconditions: [{ path: filePath, ifMatch: current.version }],
        source: 'studio',
        summary: `Split element in ${filePath}`,
        writeToken,
      });
      version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(splitRes.html));
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      matched: splitRes.matched,
      newId: splitRes.newId ?? null,
      changed: splitRes.html !== current.content,
      content: splitRes.html,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/split-batch — Atomic multi-file razor split transaction.
  // Exact shape checked by studio/src/utils/razorSplitTransaction.ts.
  app.post('/api/projects/:id/file-mutations/split-batch', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      files?: Array<{ path: string; expectedVersion?: string; targets?: AtomicCutTarget[]; cuts?: AtomicCutTarget[] }>;
    } | null;

    if (!body || !Array.isArray(body.files)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "files" array.', { status: 400, applied: false });
    }

    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const htmlByPath = new Map<string, string>();
    for (const f of virtual.listFiles()) {
      if (f.isText && (f.path.endsWith('.html') || f.path.endsWith('.htm'))) {
        const t = virtual.readText(f.path);
        if (t !== null) htmlByPath.set(f.path, t);
      }
    }
    const takenIds = collectProjectHtmlIds(htmlByPath);
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));

    const commitOps: ProjectFileOp[] = [];
    const preconditions: Array<{ path: string; ifMatch: string }> = [];
    const results: Array<{
      path: string;
      before: string;
      after: string;
      version: string;
      writeToken: string;
      splitCount: number;
      skippedSelectors: string[];
    }> = [];

    for (const entry of body.files) {
      const safePath = normalizeSafeProjectPath(entry.path, true);
      const before = virtual.readText(safePath);
      if (before === null) {
        return c.json({ ok: false, outcome: 'failed', error: `File not found: ${safePath}` }, 404);
      }
      const targets = entry.targets ?? entry.cuts;
      if (!Array.isArray(targets) || !targets.length || targets.some(cut => !cut?.target ||
          !Number.isFinite(cut.splitTime) || !Number.isFinite(cut.elementStart) || !(cut.elementDuration > 0))) {
        return c.json({ ok: false, outcome: 'failed', error: `Invalid split targets for ${safePath}` }, 400);
      }
      const beforeVersion = fileContentVersion(before);
      if (entry.expectedVersion !== undefined && entry.expectedVersion !== beforeVersion) {
        return c.json({ ok: false, outcome: 'conflict', error: `File changed before cut: ${safePath}` }, 409);
      }
      // A legacy anonymous clip gets its deterministic hf-id during preview bundling.
      const basis = targets.some(cut => cut.target.hfId && !cut.target.id) ? stampHfIdsInPlace(before) : before;
      const cutRes = applyAtomicCutsToHtml(basis, targets, takenIds);
      if (cutRes.splitCount !== targets.length) {
        return c.json({ ok: false, outcome: 'conflict', error: `Split target changed: ${safePath}` }, 409);
      }
      const after = stampHfIdsInPlace(cutRes.after);
      for (const id of cutRes.rightHalfIds) takenIds.add(id);

      const version = fileContentVersion(after);
      results.push({
        path: safePath,
        before,
        after,
        version,
        writeToken,
        splitCount: cutRes.splitCount,
        skippedSelectors: cutRes.skippedSelectors,
      });

      if (after !== before) {
        commitOps.push({ op: 'upsert_text', path: safePath, content: after });
        preconditions.push({ path: safePath, ifMatch: beforeVersion });
      }
    }

    if (commitOps.length > 0) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: commitOps,
        filePreconditions: preconditions,
        source: 'studio',
        summary: 'Razor split clips',
        writeToken,
      });
      for (const item of results) {
        if (committed.versionsByPath[item.path]) {
          item.version = committed.versionsByPath[item.path];
        }
      }
    }

    return c.json({
      ok: true,
      outcome: 'committed',
      writeToken,
      files: results,
    });
  });

  // POST /api/projects/:id/file-mutations/wrap-elements/* — Group elements into a wrapper container.
  app.post('/api/projects/:id/file-mutations/wrap-elements/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/wrap-elements/');
    const body = (await c.req.json().catch(() => null)) as {
      targets?: SourceMutationTarget[];
      groupId?: string;
      bbox?: { left: number; top: number; width: number; height: number };
      rebases?: ElementRebase[];
    } | null;
    if (!body || !Array.isArray(body.targets)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "targets" array.', { status: 400, applied: false });
    }

    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) return c.json({ error: 'Target file not found', path: filePath }, 404);

    const wrapped = wrapElementsInHtml(
      current.content,
      body.targets,
      body.groupId ?? `group-${randomUUID().slice(0, 6)}`,
      body.bbox ?? { left: 0, top: 0, width: 100, height: 100 },
      body.rebases ?? [],
    );
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = current.version;

    if (wrapped.matched && wrapped.html !== current.content) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: wrapped.html, stampHfIds: true }],
        filePreconditions: [{ path: filePath, ifMatch: current.version }],
        source: 'studio',
        summary: `Grouped elements in ${filePath}`,
        writeToken,
      });
      version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(wrapped.html));
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      wrapped: wrapped.matched,
      matched: wrapped.matched,
      groupId: wrapped.groupId ?? null,
      changed: wrapped.html !== current.content,
      content: wrapped.html,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/unwrap-elements/* — Ungroup + bake group transforms + clean GSAP.
  app.post('/api/projects/:id/file-mutations/unwrap-elements/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/unwrap-elements/');
    const body = (await c.req.json().catch(() => null)) as {
      target?: SourceMutationTarget;
      childTracks?: UnwrapChildTrack[];
    } | null;
    if (!body?.target) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "target".', { status: 400, applied: false });
    }

    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) return c.json({ error: 'Target file not found', path: filePath }, 404);

    const res = unwrapGroupWithGsapCleanup(current.content, body.target, body.childTracks);
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = current.version;

    if (res.unwrapped && res.changed) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: res.html, stampHfIds: true }],
        filePreconditions: [{ path: filePath, ifMatch: current.version }],
        source: 'studio',
        summary: `Ungrouped elements in ${filePath}`,
        writeToken,
      });
      version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(res.html));
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      unwrapped: res.unwrapped,
      changed: res.changed,
      content: res.html,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/probe-element/* — Read-only source probe.
  app.post('/api/projects/:id/file-mutations/probe-element/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/probe-element/');
    const body = (await c.req.json().catch(() => null)) as { target?: SourceMutationTarget } | null;
    if (!body?.target) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "target".', { status: 400, applied: false });
    }
    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) return c.json({ error: 'Target file not found', path: filePath }, 404);
    const exists = probeElementInSource(current.content, body.target);
    return c.json({ ok: true, exists, result: exists });
  });

  // POST /api/projects/:id/file-mutations/probe-elements/* — Read-only batch source probe.
  app.post('/api/projects/:id/file-mutations/probe-elements/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/probe-elements/');
    const body = (await c.req.json().catch(() => null)) as { targets?: SourceMutationTarget[] } | null;
    if (!body || !Array.isArray(body.targets)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "targets" array.', { status: 400, applied: false });
    }
    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) return c.json({ error: 'Target file not found', path: filePath }, 404);
    const exists = probeElementsInSource(current.content, body.targets);
    return c.json({ ok: true, exists, results: exists });
  });

  // POST /api/projects/:id/file-mutations/duplicate-element/* — Clone element & GSAP animations.
  app.post('/api/projects/:id/file-mutations/duplicate-element/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/duplicate-element/');
    const body = (await c.req.json().catch(() => null)) as {
      target?: SourceMutationTarget;
      newId?: string;
      delta?: number;
    } | null;
    if (!body?.target) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "target".', { status: 400, applied: false });
    }

    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const currentText = virtual.readText(filePath);
    if (currentText === null) return c.json({ error: 'Target file not found', path: filePath }, 404);

    const htmlByPath = new Map<string, string>();
    for (const f of virtual.listFiles()) {
      if (f.isText && (f.path.endsWith('.html') || f.path.endsWith('.htm'))) {
        const t = virtual.readText(f.path);
        if (t !== null) htmlByPath.set(f.path, t);
      }
    }

    const dup = duplicateElementInHtml(currentText, body.target, {
      newId: body.newId,
      takenIds: collectProjectHtmlIds(htmlByPath),
      delta: body.delta,
    });
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = formatVersionFromSha256(sha256Hex(dup.html));

    if (dup.matched && dup.html !== currentText) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: dup.html, stampHfIds: true }],
        filePreconditions: [{ path: filePath, ifMatch: formatVersionFromSha256(sha256Hex(currentText)) }],
        source: 'studio',
        summary: `Duplicated element in ${filePath}`,
        writeToken,
      });
      version = committed.versionsByPath[filePath] ?? version;
    }

    c.header('ETag', version);
    return c.json({
      ok: true,
      matched: dup.matched,
      clonedId: dup.clonedId,
      changed: dup.html !== currentText,
      content: dup.html,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/insert-composition/* — Insert a sub-composition host into parent HTML.
  app.post('/api/projects/:id/file-mutations/insert-composition/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/insert-composition/');
    const body = (await c.req.json().catch(() => null)) as {
      sourcePath?: string;
      start?: number;
      track?: number;
      expectedVersion?: string;
      canvasPosition?: { left: number; top: number };
    } | null;
    if (!body?.sourcePath) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "sourcePath".', { status: 400, applied: false });
    }
    const childPath = normalizeSafeProjectPath(body.sourcePath);
    const parentFile = await deps.files.readTextFile(auth, projectId, filePath);
    if (!parentFile) {
      return c.json({ error: 'Parent or child composition not found' }, 404);
    }

    if (body.expectedVersion !== undefined && body.expectedVersion !== parentFile.version) {
      return c.json({ error: 'file conflict', code: 'VERSION_MISMATCH', path: filePath }, 409);
    }
    const at = body.canvasPosition;
    if (at !== undefined && (!at || !Number.isFinite(at.left) || !Number.isFinite(at.top))) {
      return c.json({ error: 'Invalid canvas position' }, 400);
    }
    const graph = await readCompositionDependencies(filePath, childPath, path => deps.files.readTextFile(auth, projectId, path));
    const inserted = insertCompositionInMemory({
      targetPath: filePath,
      canvasPosition: at,
      parentSource: parentFile.content,
      childSource: graph.file.content,
      sourcePath: childPath,
      start: typeof body.start === 'number' ? body.start : 0,
      desiredTrack: typeof body.track === 'number' ? body.track : 0,
    });
    if (inserted.ok === false) {
      return c.json({ error: inserted.error }, inserted.status as 400);
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const after = stampHfIdsInPlace(inserted.html);
    const committed = await deps.files.commitChanges(auth, {
      projectId,
      ops: [{ op: 'upsert_text', path: filePath, content: after }],
      filePreconditions: [{ path: filePath, ifMatch: parentFile.version }, ...graph.preconditions],
      source: 'studio',
      summary: `Inserted composition ${childPath}`,
      writeToken,
    });

    const version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(after));
    c.header('ETag', version);
    return c.json({
      ok: true,
      hostId: inserted.hostId,
      before: parentFile.content,
      after,
      track: inserted.track,
      duration: inserted.duration,
      path: filePath,
      version,
      writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/relink-split-halves/* — Relink right-half split elements.
  app.post('/api/projects/:id/file-mutations/relink-split-halves/*', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const filePath = readTargetPath(c.req.url, '/file-mutations/relink-split-halves/');
    const body = (await c.req.json().catch(() => null)) as { rightHalfIds?: string[] } | null;
    if (!body || !Array.isArray(body.rightHalfIds)) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "rightHalfIds" array.', {
        status: 400,
        applied: false,
      });
    }

    const current = await deps.files.readTextFile(auth, projectId, filePath);
    if (!current) return c.json({ error: 'Target file not found', path: filePath }, 404);

    const updated = relinkSplitHalvesInHtml(current.content, body.rightHalfIds);
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    let version = current.version;

    if (updated !== current.content) {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [{ op: 'upsert_text', path: filePath, content: updated, stampHfIds: true }],
        filePreconditions: [{ path: filePath, ifMatch: current.version }],
        source: 'studio',
        summary: `Relinked split halves in ${filePath}`,
        writeToken,
      });
      version = committed.versionsByPath[filePath] ?? formatVersionFromSha256(sha256Hex(updated));
    }

    c.header('ETag', version);
    return c.json({ ok: true, changed: updated !== current.content, path: filePath, version, writeToken });
  });

  // POST /api/projects/:id/file-mutations/batch — Generic multi-file upsert/delete batch.
  app.post('/api/projects/:id/file-mutations/batch', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      files?: Array<{ path: string; content?: string; delete?: boolean }>;
      summary?: string;
    } | null;
    if (!body || !Array.isArray(body.files) || body.files.length === 0) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain non-empty "files" array.', {
        status: 400,
        applied: false,
      });
    }

    const ops: ProjectFileOp[] = body.files.map((item) =>
      item.delete
        ? { op: 'delete', path: item.path }
        : {
            op: 'upsert_text',
            path: item.path,
            content: String(item.content ?? ''),
            stampHfIds: item.path.endsWith('.html') || item.path.endsWith('.htm'),
          },
    );

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const committed = await deps.files.commitChanges(auth, {
      projectId,
      ops,
      source: 'studio',
      summary: body.summary ?? `Batch updated ${ops.length} files`,
      writeToken,
    });

    return c.json({
      ok: true,
      revision: committed.revision,
      versionId: committed.versionId,
      versionsByPath: committed.versionsByPath,
      writeToken: committed.writeToken,
    });
  });

  // POST /api/projects/:id/file-mutations/freeze-frame — Enqueue async ffmpeg freeze-frame extraction on worker-media.
  app.post('/api/projects/:id/file-mutations/freeze-frame', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      sourcePath?: string;
      timestampSec?: number;
      targetPath?: string;
    } | null;

    if (!body?.sourcePath || typeof body.timestampSec !== 'number' || body.timestampSec < 0) {
      throw new CloudError('INVALID_ARGUMENT', 'freeze-frame requires sourcePath and non-negative timestampSec.', {
        status: 400,
        applied: false,
      });
    }

    const sourceFile = await deps.files.getFile(auth, projectId, body.sourcePath);
    if (!sourceFile) {
      return c.json({ error: 'Source video not found', path: body.sourcePath }, 404);
    }

    const targetPath = normalizeSafeProjectPath(
      body.targetPath || `assets/freeze-${randomUUID().slice(0, 8)}.png`,
      true,
    );

    const jobId = randomUUID();
    const now = new Date();
    await deps.db.insert(jobs).values(
      asInsert(jobs, {
        id: jobId,
        workspaceId: auth.workspaceId,
        projectId,
        kind: 'media_ingest',
        state: 'queued',
        stage: 'freeze_frame',
        progress: 0,
        inputPayload: {
          sourcePath: sourceFile.path,
          sha256: sourceFile.sha256,
          timestampSec: body.timestampSec,
          targetPath,
        },
        createdAt: now,
        updatedAt: now,
      }),
    );

    if (deps.queues) {
      try {
        await deps.queues.enqueueMediaIngest('freeze_frame', {
          jobId,
          workspaceId: auth.workspaceId,
          projectId,
          blobScope: sourceFile.blobScope,
          sha256: sourceFile.sha256,
          timestampSec: body.timestampSec,
          targetPath,
        });
      } catch (err) {
        const failNow = new Date();
        await deps.db
          .update(jobs)
          .set(
            asUpdate(jobs, {
              state: 'failed',
              errorCode: 'QUEUE_ENQUEUE_FAILED',
              errorMessage: err instanceof Error ? err.message : 'Failed to enqueue freeze_frame job',
              terminalAt: failNow,
              updatedAt: failNow,
            }),
          )
          .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)));
        throw err;
      }
    }

    return c.json({ ok: true, jobId, status: 'queued', targetPath }, 202);
  });

  return app;
}
