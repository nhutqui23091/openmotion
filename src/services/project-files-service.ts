import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { ProjectEvent } from '../contracts/events.ts';
import type { BlobMetadata, BlobScope, PresignGetOptions, StoragePort } from '../contracts/storage.ts';
import { applyWorkspaceBlobRefDeltas, type BlobRefDelta } from '../db/cas.ts';
import type { Database, DbExecutor } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { catalogTemplateFiles, workspaceBlobs } from '../db/schema/blobs-assets.ts';
import { idempotencyReceipts, jobs } from '../db/schema/jobs.ts';
import {
  projectFiles,
  projectHistoryEntries,
  projectVersionFiles,
  projectVersions,
  type HistoryActorKind,
  type ProjectVersionSource,
} from '../db/schema/project-files.ts';
import { projectGrants, projects } from '../db/schema/projects.ts';
import { projectChannel, workspaceCatalogChannel } from '../infra/redis.ts';
import { assertTenantScopedKey, catalogBlobKey, workspaceBlobKey } from '../infra/storage.ts';
import {
  assertWritableProjectPath,
  computeProjectRevision,
  isTextProjectPath,
  isUuid,
  projectPath,
} from '../../shared/project-validation.ts';
import {
  computePreviewImpact,
  createWriteToken,
  formatVersionFromSha256,
  getMimeType,
  sha256Hex,
} from '../studio/etag.ts';
import {
  InMemoryVirtualProject,
  normalizeVirtualPath,
  type VirtualFileRecord,
} from '../studio/virtual-project-store.ts';

export const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BATCH_FILE_OPS = 256;
export const DEFAULT_HISTORY_COALESCE_WINDOW_MS = 4000;
const GC_RETRY_ATTEMPTS = 3;

export interface HotTextCachePort {
  getText(sha256: string): Promise<string | null>;
  setText(sha256: string, content: string, ttlSec?: number): Promise<boolean>;
  getFontCss?(hash: string): Promise<string | null>;
  setFontCss?(hash: string, css: string, ttlSec?: number): Promise<boolean>;
}

export interface EventBusPort {
  publish(channel: string, payload: unknown): Promise<number>;
}

export interface ProjectFilesServiceDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly hotTextCache?: HotTextCachePort;
  readonly eventBus?: EventBusPort;
  /** Coalesce rapid interactive Studio edits within this window (ms). Set 0 to disable coalescing. Defaults to 4000ms. */
  readonly historyCoalesceWindowMs?: number;
  /** Optional clock provider for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export type ProjectFileOp =
  | {
      readonly op: 'upsert_text';
      readonly path: string;
      readonly content: string;
      readonly mimeType?: string;
      readonly stampHfIds?: boolean;
    }
  | {
      readonly op: 'upsert_binary';
      readonly path: string;
      readonly data: Buffer;
      readonly mimeType?: string;
      readonly metadata?: BlobMetadata | null;
    }
  | {
      readonly op: 'upsert_ref';
      readonly path: string;
      readonly blobScope: BlobScope;
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly mimeType: string;
      readonly isText: boolean;
      readonly metadata?: BlobMetadata | null;
    }
  | {
      readonly op: 'delete';
      readonly path: string;
    };

export interface FilePrecondition {
  readonly path: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
}

export interface CommitProjectFilesInput {
  readonly projectId: string;
  readonly ops: readonly ProjectFileOp[];
  readonly expectedRevision?: string;
  readonly expectedVersionId?: string;
  readonly filePreconditions?: readonly FilePrecondition[];
  readonly requestId?: string;
  readonly idempotencyScope?: string;
  /** For derived edits the logical request is stable even when its generated HTML is not. */
  readonly commandReceipt?: { inputHash: string; result: Record<string, unknown> };
  readonly origin?: 'studio' | 'mcp' | 'agent' | 'import' | 'system';
  readonly source?: ProjectVersionSource;
  readonly summary?: string;
  readonly actorKind?: HistoryActorKind;
  readonly actorName?: string;
  readonly windowId?: string | null;
  readonly writeToken?: string | null;
  readonly skipVersion?: boolean;
  readonly forceVersion?: boolean;
  readonly projectUpdates?: {
    readonly namingLanguage?: string | null;
    readonly requirements?: string | null;
    readonly title?: string;
  };
}

export interface CommitProjectFilesResult {
  readonly projectId: string;
  readonly revision: string;
  readonly versionId: string | null;
  readonly versionNumber: number;
  readonly historySeq: number;
  readonly changedPaths: string[];
  readonly deletedPaths: string[];
  readonly versionsByPath: Record<string, string>;
  readonly writeToken: string;
  readonly affectsPreview: boolean;
  readonly fileTreeChanged?: boolean;
  readonly affectedCompositions: string[];
  readonly replayed: boolean;
  readonly commandResult?: Record<string, unknown>;
  readonly coalesced?: boolean;
}

export interface ReadTextFileResult {
  readonly file: VirtualFileRecord;
  readonly content: string;
  readonly version: string;
}

export interface ReadBinaryFileResult {
  readonly file: VirtualFileRecord;
  readonly buffer: Buffer;
  readonly version: string;
}

interface PreparedBlobUpload {
  readonly sha256: string;
  readonly s3Key: string;
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly textContent?: string;
  readonly metadata?: BlobMetadata | null;
}

type PreparedFileOp =
  | {
      readonly op: 'upsert';
      readonly path: string;
      readonly blobScope: BlobScope;
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly mimeType: string;
      readonly isText: boolean;
      readonly metadata?: BlobMetadata | null;
    }
  | {
      readonly op: 'delete';
      readonly path: string;
    };

export type ProjectRecord = typeof projects.$inferSelect;

export function assertValidUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new CloudError('INVALID_ARGUMENT', `${label} must be a valid UUID`, {
      status: 400,
      applied: false,
    });
  }
  return value;
}

export function normalizeSafeProjectPath(rawPath: string, writable = false): string {
  const cleaned = normalizeVirtualPath(rawPath);
  try {
    const validated = projectPath(cleaned);
    if (writable) assertWritableProjectPath(validated);
    return validated;
  } catch (error) {
    throw new CloudError(
      'INVALID_PATH',
      error instanceof Error ? error.message : `Invalid project path: ${rawPath}`,
      { status: 400, applied: false },
    );
  }
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  const inspectLen = Math.min(buffer.byteLength, 8000);
  for (let i = 0; i < inspectLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function resolveBlobStorageKey(workspaceId: string, blobScope: BlobScope, sha256: string): string {
  const key = blobScope === 'catalog' ? catalogBlobKey(sha256) : workspaceBlobKey(workspaceId, sha256);
  return assertTenantScopedKey(workspaceId, key, { allowCatalog: blobScope === 'catalog' });
}

export function canonicalInputHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function readCommitReceipt(
  db: DbExecutor, workspaceId: string, scope: string, requestId: string, inputHash: string, lock = false,
): Promise<CommitProjectFilesResult | null> {
  const query = db
    .select()
    .from(idempotencyReceipts)
    .where(
      and(
        eq(idempotencyReceipts.workspaceId, workspaceId),
        eq(idempotencyReceipts.scope, scope),
        eq(idempotencyReceipts.requestId, requestId),
      ),
    )
    .limit(1);
  const [receipt] = lock ? await query.for('update') : await query;
  if (receipt) {
    if (receipt.inputHash.trim() !== inputHash) {
      throw new CloudError(
        'REQUEST_ID_CONFLICT',
        `requestId "${requestId}" was already used with a different payload.`,
        { status: 409, applied: false, details: { requestId, scope } },
      );
    }
    if (receipt.state === 'completed' && receipt.responsePayload) {
      return {
        ...(receipt.responsePayload as unknown as CommitProjectFilesResult),
        replayed: true,
      };
    }
  }
  return null;
}

export async function assertAgentProjectAccess(
  db: DbExecutor,
  auth: AuthContext,
  project: ProjectRecord,
): Promise<void> {
  if (auth.authMethod === 'preview_token') {
    if (auth.tokenId !== `om_preview:${project.id}`) {
      throw new CloudError('PROJECT_NOT_FOUND', `Project ${project.id} was not found in this workspace.`, {
        status: 404,
        applied: false,
      });
    }
    return;
  }
  if (auth.authMethod !== 'oauth_bearer') return;

  // Owner check: if the project records an ownerUserId, a different user gets the same 404
  // (`project_not_found`) so unauthorized callers cannot probe project existence.
  if (project.ownerUserId && project.ownerUserId !== auth.userId) {
    throw new CloudError('PROJECT_NOT_FOUND', `Project ${project.id} was not found in this workspace.`, {
      status: 404,
      applied: false,
    });
  }

  if (!auth.clientId) {
    throw new CloudError(
      'PROJECT_GRANT_REQUIRED',
      'This agent connection does not have project authorization. Grant access in OpenDesign project settings.',
      { status: 403, applied: false, details: { projectId: project.id } },
    );
  }

  const [grant] = await db
    .select({ id: projectGrants.id })
    .from(projectGrants)
    .where(
      and(
        eq(projectGrants.projectId, project.id),
        eq(projectGrants.userId, auth.userId),
        eq(projectGrants.clientId, auth.clientId),
        isNull(projectGrants.revokedAt),
      ),
    )
    .limit(1);

  if (!grant) {
    throw new CloudError(
      'PROJECT_GRANT_REQUIRED',
      'This agent connection is not authorized for this project. Open the project in OpenDesign and grant access.',
      { status: 403, applied: false, details: { projectId: project.id, clientId: auth.clientId } },
    );
  }
}

export async function loadProjectOrThrow(
  db: DbExecutor,
  workspaceId: string,
  projectId: string,
  options: { allowTrashed?: boolean; forUpdate?: boolean; auth?: AuthContext } = {},
): Promise<ProjectRecord> {
  assertValidUuid(workspaceId, 'workspaceId');
  assertValidUuid(projectId, 'projectId');

  const query = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));

  const rows = options.forUpdate ? await query.for('update') : await query;
  const project = rows[0];
  if (!project) {
    throw new CloudError('PROJECT_NOT_FOUND', `Project ${projectId} was not found in this workspace.`, {
      status: 404,
      applied: false,
    });
  }
  if (options.auth) {
    await assertAgentProjectAccess(db, options.auth, project);
  }
  if (project.trashed && !options.allowTrashed) {
    throw new CloudError('PROJECT_TRASHED', `Project ${projectId} is in the trash and cannot be modified.`, {
      status: 400,
      applied: false,
    });
  }
  return project;
}

function actorDefaults(ctx: AuthContext, actorKind?: HistoryActorKind, actorName?: string): {
  actorKind: HistoryActorKind;
  actorName: string;
} {
  const kind: HistoryActorKind =
    actorKind ?? (ctx.authMethod === 'session_cookie' || ctx.authMethod === 'dev_bypass' ? 'user' : 'agent');
  const name = (actorName?.trim() || ctx.displayName?.trim() || ctx.email?.trim() || kind).slice(0, 128);
  return { actorKind: kind, actorName: name };
}

export class ProjectFilesService {
  private readonly db: Database;
  private readonly storage: StoragePort;
  private readonly hotTextCache?: HotTextCachePort;
  private readonly eventBus?: EventBusPort;
  private readonly historyCoalesceWindowMs: number;
  private readonly nowFn: () => Date;

  constructor(deps: ProjectFilesServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.hotTextCache = deps.hotTextCache;
    this.eventBus = deps.eventBus;
    this.historyCoalesceWindowMs = Math.max(
      0,
      Math.floor(deps.historyCoalesceWindowMs ?? DEFAULT_HISTORY_COALESCE_WINDOW_MS),
    );
    this.nowFn = deps.now ?? (() => new Date());
  }

  /**
   * List all files in a project along with cached media metadata from `workspace_blobs`
   * and `catalog_template_files`. Never hits local disk.
   */
  async listFiles(ctx: AuthContext, projectId: string, options: { allowTrashed?: boolean } = {}): Promise<VirtualFileRecord[]> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, {
      allowTrashed: options.allowTrashed ?? true,
      auth: ctx,
    });

    const rows = await this.db
      .select()
      .from(projectFiles)
      .where(and(eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, project.id)))
      .orderBy(asc(projectFiles.path));

    if (rows.length === 0) return [];

    const workspaceShas = [...new Set(rows.filter((r) => r.blobScope === 'workspace').map((r) => r.sha256.trim()))];
    const catalogShas = [...new Set(rows.filter((r) => r.blobScope === 'catalog').map((r) => r.sha256.trim()))];

    const workspaceMetaMap = new Map<string, BlobMetadata | null>();
    if (workspaceShas.length > 0) {
      const blobRows = await this.db
        .select({ sha256: workspaceBlobs.sha256, metadata: workspaceBlobs.metadata })
        .from(workspaceBlobs)
        .where(and(eq(workspaceBlobs.workspaceId, ctx.workspaceId), inArray(workspaceBlobs.sha256, workspaceShas)));
      for (const blob of blobRows) {
        workspaceMetaMap.set(blob.sha256.trim(), blob.metadata ?? null);
      }
    }

    const catalogMetaMap = new Map<string, BlobMetadata | null>();
    if (catalogShas.length > 0) {
      const catRows = await this.db
        .select({ sha256: catalogTemplateFiles.sha256, metadata: catalogTemplateFiles.metadata })
        .from(catalogTemplateFiles)
        .where(inArray(catalogTemplateFiles.sha256, catalogShas));
      for (const cat of catRows) {
        const key = cat.sha256.trim();
        if (!catalogMetaMap.has(key) || cat.metadata) {
          catalogMetaMap.set(key, cat.metadata ?? null);
        }
      }
    }

    return rows.map((row) => {
      const sha256 = row.sha256.trim();
      const metadata =
        row.blobScope === 'catalog'
          ? (catalogMetaMap.get(sha256) ?? null)
          : (workspaceMetaMap.get(sha256) ?? null);
      return {
        path: row.path,
        blobScope: row.blobScope,
        sha256,
        sizeBytes: Number(row.sizeBytes),
        mimeType: row.mimeType,
        isText: row.isText,
        updatedAt: row.updatedAt,
        metadata,
      };
    });
  }

  /** Lookup metadata for a single project file (PG metadata only, zero S3 read). */
  async getFile(
    ctx: AuthContext,
    projectId: string,
    filePath: string,
    options: { allowTrashed?: boolean } = {},
  ): Promise<VirtualFileRecord | null> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, {
      allowTrashed: options.allowTrashed ?? true,
      auth: ctx,
    });
    const safePath = normalizeSafeProjectPath(filePath);

    const rows = await this.db
      .select()
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.workspaceId, ctx.workspaceId),
          eq(projectFiles.projectId, project.id),
          eq(projectFiles.path, safePath),
        ),
      );
    const row = rows[0];
    if (!row) return null;

    const sha256 = row.sha256.trim();
    let metadata: BlobMetadata | null = null;
    if (row.blobScope === 'workspace') {
      const blobRows = await this.db
        .select({ metadata: workspaceBlobs.metadata })
        .from(workspaceBlobs)
        .where(and(eq(workspaceBlobs.workspaceId, ctx.workspaceId), eq(workspaceBlobs.sha256, sha256)));
      metadata = blobRows[0]?.metadata ?? null;
    } else {
      const catRows = await this.db
        .select({ metadata: catalogTemplateFiles.metadata })
        .from(catalogTemplateFiles)
        .where(eq(catalogTemplateFiles.sha256, sha256))
        .limit(1);
      metadata = catRows[0]?.metadata ?? null;
    }

    return {
      path: row.path,
      blobScope: row.blobScope,
      sha256,
      sizeBytes: Number(row.sizeBytes),
      mimeType: row.mimeType,
      isText: row.isText,
      updatedAt: row.updatedAt,
      metadata,
    };
  }

  /** Read a text blob via SHA-256 HotTextCache -> S3 CAS fallback + async cache warm. */
  async readTextBlob(workspaceId: string, blobScope: BlobScope, sha256: string): Promise<string> {
    if (this.hotTextCache) {
      try {
        const cached = await this.hotTextCache.getText(sha256);
        if (cached !== null) return cached;
      } catch {
        // Fall through to authoritative S3 CAS.
      }
    }

    const key = resolveBlobStorageKey(workspaceId, blobScope, sha256);
    const buffer = await this.storage.getObjectBuffer(key, MAX_TEXT_FILE_BYTES);
    const content = buffer.toString('utf8');

    if (this.hotTextCache) {
      void this.hotTextCache.setText(sha256, content).catch(() => {});
    }
    return content;
  }

  /** Capture authorized source metadata before checking the receipt. A concurrent replay
   * either sees the completed command here or under the project lock at commit. */
  async readTextForCommand(
    ctx: AuthContext, projectId: string, path: string, scope: string, requestId: string, inputHash: string,
  ) {
    const file = await this.getFile(ctx, projectId, path, { allowTrashed: false });
    const replay = await readCommitReceipt(this.db, ctx.workspaceId, scope, requestId, inputHash);
    if (replay) return { kind: 'replay' as const, commit: replay };
    if (!file) throw new CloudError('NOT_FOUND', 'Composition file not found', { status: 404 });
    if (!file.isText) throw new CloudError('INVALID_ARGUMENT', 'Composition must be a text file', { status: 415 });
    return { kind: 'source' as const, content: await this.readTextBlob(ctx.workspaceId, file.blobScope, file.sha256) };
  }

  /** Read a binary blob directly from S3 CAS. */
  async readBinaryBlob(workspaceId: string, blobScope: BlobScope, sha256: string, maxBytes?: number): Promise<Buffer> {
    const key = resolveBlobStorageKey(workspaceId, blobScope, sha256);
    return this.storage.getObjectBuffer(key, maxBytes);
  }

  /** Read a single text file from a project. Throws `INVALID_ARGUMENT` (415) if binary. */
  async readTextFile(
    ctx: AuthContext,
    projectId: string,
    filePath: string,
  ): Promise<ReadTextFileResult | null> {
    const file = await this.getFile(ctx, projectId, filePath);
    if (!file) return null;
    if (!file.isText) {
      throw new CloudError('INVALID_ARGUMENT', `File "${file.path}" is binary and cannot be read as text.`, {
        status: 415,
        applied: false,
        details: { why: 'binary', path: file.path, version: formatVersionFromSha256(file.sha256) },
      });
    }
    const content = await this.readTextBlob(ctx.workspaceId, file.blobScope, file.sha256);
    return {
      file,
      content,
      version: formatVersionFromSha256(file.sha256),
    };
  }

  /** Read a single file as raw Buffer from S3 CAS. */
  async readBinaryFile(
    ctx: AuthContext,
    projectId: string,
    filePath: string,
    maxBytes?: number,
  ): Promise<ReadBinaryFileResult | null> {
    const file = await this.getFile(ctx, projectId, filePath);
    if (!file) return null;
    const buffer = await this.readBinaryBlob(ctx.workspaceId, file.blobScope, file.sha256, maxBytes);
    return {
      file,
      buffer,
      version: formatVersionFromSha256(file.sha256),
    };
  }

  /** Generate a short-lived tenant-scoped Presigned GET URL for a project file. */
  async presignFileGet(
    ctx: AuthContext,
    projectId: string,
    filePath: string,
    options: PresignGetOptions = {},
  ): Promise<{ file: VirtualFileRecord; url: string; etag: string } | null> {
    const file = await this.getFile(ctx, projectId, filePath);
    if (!file) return null;
    const key = resolveBlobStorageKey(ctx.workspaceId, file.blobScope, file.sha256);
    const url = await this.storage.presignGet(key, {
      expiresInSec: options.expiresInSec ?? 300,
      responseContentType: options.responseContentType ?? file.mimeType,
      ...(options.responseContentDisposition
        ? { responseContentDisposition: options.responseContentDisposition }
        : {}),
    });
    return {
      file,
      url,
      etag: formatVersionFromSha256(file.sha256),
    };
  }

  /**
   * Load an immutable in-memory snapshot (`InMemoryVirtualProject`) of a project's files and
   * text contents for `bundlePreviewInMemory`, `lintProjectInMemory`, `infoInMemory`, and `timelineInMemory`.
   */
  async loadVirtualProject(ctx: AuthContext, projectId: string): Promise<InMemoryVirtualProject> {
    const project = await loadProjectOrThrow(this.db, ctx.workspaceId, projectId, {
      allowTrashed: true,
      auth: ctx,
    });
    const files = await this.listFiles(ctx, projectId, { allowTrashed: true });

    const textContents = new Map<string, string>();
    const textFiles = files.filter((f) => f.isText);

    // Deduplicate blob fetches when multiple paths share the same SHA-256.
    const uniqueBlobs = new Map<string, { blobScope: BlobScope; sha256: string }>();
    for (const file of textFiles) {
      const cacheId = `${file.blobScope}:${file.sha256}`;
      if (!uniqueBlobs.has(cacheId)) {
        uniqueBlobs.set(cacheId, { blobScope: file.blobScope, sha256: file.sha256 });
      }
    }

    const loadedByBlob = new Map<string, string>();
    await Promise.all(
      [...uniqueBlobs.entries()].map(async ([cacheId, ref]) => {
        const text = await this.readTextBlob(ctx.workspaceId, ref.blobScope, ref.sha256);
        loadedByBlob.set(cacheId, text);
      }),
    );

    for (const file of textFiles) {
      const content = loadedByBlob.get(`${file.blobScope}:${file.sha256}`);
      if (content !== undefined) {
        textContents.set(file.path, content);
      }
    }

    return new InMemoryVirtualProject({
      projectId: project.id,
      projectName: project.title,
      // A commit may land between loading the project and listing its files.
      revision: computeProjectRevision(files.map(f => ({ path: f.path, size: f.sizeBytes, hash: f.sha256 }))),
      files,
      textContents,
    });
  }

  /**
   * Atomically commit one or more file edits/deletions to a project using:
   * 1. Pre-transaction S3 CAS upload (`putBlobIfAbsent`)
   * 2. `SELECT ... FOR UPDATE` row lock on `projects`
   * 3. `idempotency_receipts` deduplication & inputHash verification
   * 4. Optimistic concurrency check (`expectedRevision`, `expectedVersionId`, per-file `If-Match`/`If-None-Match`)
   * 5. Deadlock-free sorted-`sha256` `applyWorkspaceBlobRefDeltas`
   * 6. Canonical SHA-256 `revision` recomputation + unified PG version & history append
   * 7. Post-commit `HotTextCache` warm + `RedisEventBus` notification (`om:project:{wid}:{pid}`).
   */
  async commitChanges(ctx: AuthContext, input: CommitProjectFilesInput): Promise<CommitProjectFilesResult> {
    assertValidUuid(ctx.workspaceId, 'workspaceId');
    assertValidUuid(input.projectId, 'projectId');

    if (input.ops.length > MAX_BATCH_FILE_OPS) {
      throw new CloudError('INVALID_ARGUMENT', `Too many file operations in one commit (max ${MAX_BATCH_FILE_OPS}).`, {
        status: 400,
        applied: false,
      });
    }

    const writeToken = createWriteToken(input.writeToken);
    const { preparedOps, uploads } = this.prepareOperations(ctx.workspaceId, input.ops);

    // Build deterministic idempotency hash before hitting PG.
    const scope = input.idempotencyScope ?? 'project:files:commit';
    const inputHash = input.requestId
      ? input.commandReceipt?.inputHash ?? canonicalInputHash({
          projectId: input.projectId,
          ops: preparedOps.map((op) =>
            op.op === 'delete'
              ? { op: 'delete', path: op.path }
              : {
                  op: 'upsert',
                  path: op.path,
                  blobScope: op.blobScope,
                  sha256: op.sha256,
                  sizeBytes: op.sizeBytes,
                  mimeType: op.mimeType,
                },
          ),
          projectUpdates: input.projectUpdates ?? null,
        })
      : null;

    // Upload every new workspace blob to S3 CAS BEFORE opening the PostgreSQL transaction.
    const uploadAllBlobs = async () => {
      for (const upload of uploads.values()) {
        await this.storage.putBlobIfAbsent(upload.s3Key, upload.buffer, upload.mimeType);
      }
    };
    await uploadAllBlobs();

    let result: CommitProjectFilesResult | null = null;
    for (let attempt = 0; attempt < GC_RETRY_ATTEMPTS; attempt++) {
      try {
        result = await this.executeCommitTransaction(
          ctx,
          input,
          preparedOps,
          uploads,
          writeToken,
          scope,
          inputHash,
        );
        break;
      } catch (error) {
        if (isCloudError(error) && error.code === 'BLOB_GC_IN_PROGRESS' && attempt + 1 < GC_RETRY_ATTEMPTS) {
          await uploadAllBlobs();
          continue;
        }
        throw error;
      }
    }

    if (!result) {
      throw new CloudError('STORAGE_ERROR', 'Failed to commit project file changes.', {
        status: 500,
        applied: false,
      });
    }

    // Post-commit ONLY: warm HotTextCache and publish to RedisEventBus.
    if (!result.replayed) {
      if (this.hotTextCache) {
        for (const upload of uploads.values()) {
          if (upload.textContent !== undefined) {
            void this.hotTextCache.setText(upload.sha256, upload.textContent).catch(() => {});
          }
        }
      }

      if (this.eventBus && input.projectUpdates?.title !== undefined) {
        void this.eventBus.publish(workspaceCatalogChannel(ctx.workspaceId), { type: 'catalog-changed' }).catch(() => {});
      }
      const eventPaths = [...new Set([...result.changedPaths, ...result.deletedPaths])];
      if (this.eventBus && eventPaths.length > 0) {
        const event: ProjectEvent = {
          type: 'file-change',
          workspaceId: ctx.workspaceId,
          projectId: input.projectId,
          revision: result.revision,
          versionId: result.versionId ?? undefined,
          paths: eventPaths,
          writeToken: result.writeToken,
          affectsPreview: result.affectsPreview,
          fileTreeChanged: result.fileTreeChanged,
          affectedCompositions: result.affectedCompositions,
          ts: Date.now(),
        };
        void this.eventBus.publish(projectChannel(ctx.workspaceId, input.projectId), event).catch(() => {});
      }
      if (this.eventBus && !input.skipVersion && (eventPaths.length || input.forceVersion)) {
        const historyEvent: ProjectEvent = {
          type: 'history-changed',
          workspaceId: ctx.workspaceId,
          projectId: input.projectId,
          revision: result.revision,
          versionId: result.versionId ?? undefined,
          historySeq: result.historySeq,
          ts: Date.now(),
        };
        void this.eventBus.publish(projectChannel(ctx.workspaceId, input.projectId), historyEvent).catch(() => {});
      }
    }

    return result;
  }

  private prepareOperations(
    workspaceId: string,
    ops: readonly ProjectFileOp[],
  ): {
    preparedOps: PreparedFileOp[];
    uploads: Map<string, PreparedBlobUpload>;
  } {
    const uploads = new Map<string, PreparedBlobUpload>();
    const preparedOps: PreparedFileOp[] = [];

    for (const op of ops) {
      if (op.op === 'delete') {
        const safePath = normalizeSafeProjectPath(op.path);
        preparedOps.push({ op: 'delete', path: safePath });
        continue;
      }

      const safePath = normalizeSafeProjectPath(op.path, true);
      if (op.op === 'upsert_text') {
        let text = op.content;
        if (op.stampHfIds && (safePath.endsWith('.html') || safePath.endsWith('.htm'))) {
          text = stampHfIdsInPlace(text);
        }
        const buffer = Buffer.from(text, 'utf8');
        if (buffer.byteLength > MAX_TEXT_FILE_BYTES) {
          throw new CloudError('INVALID_ARGUMENT', `Text file "${safePath}" exceeds 16 MB limit.`, {
            status: 413,
            applied: false,
          });
        }
        const sha256 = sha256Hex(buffer);
        const mimeType = op.mimeType ?? getMimeType(safePath);
        const s3Key = workspaceBlobKey(workspaceId, sha256);
        if (!uploads.has(sha256)) {
          uploads.set(sha256, {
            sha256,
            s3Key,
            buffer,
            mimeType,
            textContent: text,
          });
        }
        preparedOps.push({
          op: 'upsert',
          path: safePath,
          blobScope: 'workspace',
          sha256,
          sizeBytes: buffer.byteLength,
          mimeType,
          isText: true,
        });
      } else if (op.op === 'upsert_binary') {
        const buffer = op.data;
        const sha256 = sha256Hex(buffer);
        const mimeType = op.mimeType ?? getMimeType(safePath);
        const s3Key = workspaceBlobKey(workspaceId, sha256);
        const isText = isTextProjectPath(safePath) && !isBinaryBuffer(buffer);
        if (!uploads.has(sha256)) {
          uploads.set(sha256, {
            sha256,
            s3Key,
            buffer,
            mimeType,
            textContent: isText ? buffer.toString('utf8') : undefined,
            metadata: op.metadata,
          });
        }
        preparedOps.push({
          op: 'upsert',
          path: safePath,
          blobScope: 'workspace',
          sha256,
          sizeBytes: buffer.byteLength,
          mimeType,
          isText,
          metadata: op.metadata,
        });
      } else {
        preparedOps.push({
          op: 'upsert',
          path: safePath,
          blobScope: op.blobScope,
          sha256: op.sha256,
          sizeBytes: op.sizeBytes,
          mimeType: op.mimeType,
          isText: op.isText,
          metadata: op.metadata,
        });
      }
    }

    return { preparedOps, uploads };
  }

  private async executeCommitTransaction(
    ctx: AuthContext,
    input: CommitProjectFilesInput,
    preparedOps: readonly PreparedFileOp[],
    uploads: ReadonlyMap<string, PreparedBlobUpload>,
    writeToken: string,
    scope: string,
    inputHash: string | null,
  ): Promise<CommitProjectFilesResult> {
    return this.db.transaction(async (tx) => {
      const project = await loadProjectOrThrow(tx, ctx.workspaceId, input.projectId, {
        allowTrashed: false,
        forUpdate: true,
        auth: ctx,
      });

      if (input.requestId && inputHash) {
        const replay = await readCommitReceipt(tx, ctx.workspaceId, scope, input.requestId, inputHash, true);
        if (replay) return replay;
      }

      const currentRevision = project.revision.trim();
      const currentVersionId = project.currentVersionId ?? null;

      // 2. Enforce project-level optimistic concurrency locks.
      if (input.expectedRevision !== undefined && currentRevision !== input.expectedRevision.trim()) {
        throw new CloudError(
          'VERSION_CONFLICT',
          'Project revision mismatch; reload the latest revision before retrying.',
          {
            status: 409,
            applied: false,
            details: {
              expectedRevision: input.expectedRevision,
              currentRevision,
              currentVersionId,
              currentVersionNumber: project.currentVersionNumber,
            },
          },
        );
      }

      if (input.expectedVersionId !== undefined && currentVersionId !== input.expectedVersionId) {
        throw new CloudError(
          'VERSION_CONFLICT',
          'Project versionId mismatch; reload the latest version before retrying.',
          {
            status: 409,
            applied: false,
            details: {
              expectedVersionId: input.expectedVersionId,
              currentRevision,
              currentVersionId,
              currentVersionNumber: project.currentVersionNumber,
            },
          },
        );
      }

      // 3. Load current live project_files rows.
      const existingRows = await tx
        .select()
        .from(projectFiles)
        .where(and(eq(projectFiles.workspaceId, ctx.workspaceId), eq(projectFiles.projectId, project.id)));

      const currentByPath = new Map<
        string,
        {
          path: string;
          blobScope: BlobScope;
          sha256: string;
          sizeBytes: number;
          mimeType: string;
          isText: boolean;
        }
      >();
      for (const row of existingRows) {
        currentByPath.set(row.path, {
          path: row.path,
          blobScope: row.blobScope,
          sha256: row.sha256.trim(),
          sizeBytes: Number(row.sizeBytes),
          mimeType: row.mimeType,
          isText: row.isText,
        });
      }

      // 4. Enforce per-file Studio ETag preconditions (`If-Match` / `If-None-Match`).
      if (input.filePreconditions) {
        for (const pre of input.filePreconditions) {
          const safePath = normalizeSafeProjectPath(pre.path);
          const existing = currentByPath.get(safePath);
          const currentVersion = existing ? formatVersionFromSha256(existing.sha256) : null;

          if (pre.ifNoneMatch === '*') {
            if (existing) {
              throw new CloudError('VERSION_CONFLICT', `File "${safePath}" already exists.`, {
                status: 409,
                applied: false,
                details: {
                  code: 'VERSION_MISMATCH',
                  path: safePath,
                  currentVersion,
                  currentSha256: existing.sha256,
                  currentBlobScope: existing.blobScope,
                  currentIsText: existing.isText,
                },
              });
            }
          } else if (pre.ifMatch !== undefined) {
            const expectedTag = pre.ifMatch.trim();
            if (expectedTag !== '*' && currentVersion !== expectedTag) {
              throw new CloudError('VERSION_CONFLICT', `File "${safePath}" has changed since last read.`, {
                status: 409,
                applied: false,
                details: {
                  code: 'VERSION_MISMATCH',
                  path: safePath,
                  expectedVersion: expectedTag,
                  currentVersion,
                  currentSha256: existing?.sha256 ?? null,
                  currentBlobScope: existing?.blobScope ?? null,
                  currentIsText: existing?.isText ?? false,
                },
              });
            }
          }
        }
      }

      // 5. Compute next live file map and diff.
      const nextByPath = new Map(currentByPath);
      const changedPaths = new Set<string>();
      const deletedPaths = new Set<string>();
      const metadataBySha = new Map<string, BlobMetadata>();

      for (const upload of uploads.values()) {
        if (upload.metadata) metadataBySha.set(upload.sha256, upload.metadata);
      }

      for (const op of preparedOps) {
        if (op.op === 'delete') {
          if (nextByPath.has(op.path)) {
            nextByPath.delete(op.path);
            deletedPaths.add(op.path);
            changedPaths.delete(op.path);
          }
        } else {
          if (op.metadata) metadataBySha.set(op.sha256, op.metadata);
          const prev = nextByPath.get(op.path);
          const unchanged =
            prev &&
            prev.blobScope === op.blobScope &&
            prev.sha256 === op.sha256 &&
            prev.sizeBytes === op.sizeBytes &&
            prev.mimeType === op.mimeType &&
            prev.isText === op.isText;
          if (!unchanged) {
            nextByPath.set(op.path, {
              path: op.path,
              blobScope: op.blobScope,
              sha256: op.sha256,
              sizeBytes: op.sizeBytes,
              mimeType: op.mimeType,
              isText: op.isText,
            });
            changedPaths.add(op.path);
            deletedPaths.delete(op.path);
          }
        }
      }

      const hasFileChanges = changedPaths.size > 0 || deletedPaths.size > 0;
      const hasProjectUpdates = Boolean(input.projectUpdates && Object.keys(input.projectUpdates).length > 0);
      const shouldCreateVersion = !input.skipVersion && (hasFileChanges || Boolean(input.forceVersion));
      const now = this.nowFn();
      const actor = actorDefaults(ctx, input.actorKind, input.actorName);
      const safeWindowId = input.windowId && isUuid(input.windowId) ? input.windowId : null;
      const effectiveSource: ProjectVersionSource = input.source ?? 'studio';
      const summary = (
        input.summary?.trim() ||
        buildAutoSummary([...changedPaths], [...deletedPaths])
      ).slice(0, 256);

      // 5b. High-frequency Studio edit-window coalescing check (c2):
      // Coalesce rapid interactive Studio edits into the unpinned, non-export-referenced head version
      // using delta project_version_files upserts/deletes instead of duplicating all N project files.
      let coalesceTarget: {
        versionId: string;
        historyEntryId: string;
        touchedVersionFiles: Map<string, { blobScope: BlobScope; sha256: string }>;
      } | null = null;

      const isInteractiveStudioEdit =
        effectiveSource === 'studio' &&
        (input.origin === undefined || input.origin === 'studio') &&
        input.actorKind !== 'agent' &&
        input.actorKind !== 'system' &&
        !input.forceVersion;

      if (
        shouldCreateVersion &&
        hasFileChanges &&
        this.historyCoalesceWindowMs > 0 &&
        isInteractiveStudioEdit &&
        currentVersionId !== null &&
        project.currentHistorySeq > 0
      ) {
        const headVersionRows = await tx
          .select()
          .from(projectVersions)
          .where(
            and(
              eq(projectVersions.workspaceId, ctx.workspaceId),
              eq(projectVersions.projectId, project.id),
              eq(projectVersions.id, currentVersionId),
            ),
          )
          .limit(1);
        const headEntryRows = await tx
          .select()
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
              eq(projectHistoryEntries.seq, project.currentHistorySeq),
            ),
          )
          .limit(1);
        const maxSeqRows = await tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${projectHistoryEntries.seq}), 0)` })
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
            ),
          );

        const headVersion = headVersionRows[0];
        const headEntry = headEntryRows[0];
        const maxHistorySeq = Number(maxSeqRows[0]?.maxSeq ?? 0);

        if (
          headVersion &&
          headEntry &&
          headEntry.versionId === currentVersionId &&
          !headVersion.pinned &&
          !headEntry.pinned &&
          !headEntry.undone &&
          headVersion.source === 'studio' &&
          headVersion.revision.trim() === currentRevision &&
          project.currentHistorySeq === maxHistorySeq &&
          headEntry.actorKind === actor.actorKind &&
          headEntry.actorName === actor.actorName &&
          (safeWindowId === null || headEntry.windowId === safeWindowId)
        ) {
          const headReferenceMs = Math.min(headEntry.startedAt.getTime(), headEntry.endedAt.getTime());
          const elapsedMs = now.getTime() - headReferenceMs;
          if (elapsedMs >= 0 && elapsedMs <= this.historyCoalesceWindowMs) {
            // Guarantee frozen export / worker snapshots are strictly immutable:
            // never mutate a version referenced by any `jobs` row (`version_id` or `input_payload.versionId`).
            const projectJobs = await tx
              .select({
                id: jobs.id,
                versionId: jobs.versionId,
                inputPayload: jobs.inputPayload,
              })
              .from(jobs)
              .where(and(eq(jobs.workspaceId, ctx.workspaceId), eq(jobs.projectId, project.id)));

            const referencedByJob = projectJobs.some((job) => {
              if (job.versionId === currentVersionId) return true;
              const payload = job.inputPayload as Record<string, unknown> | null | undefined;
              return typeof payload?.versionId === 'string' && payload.versionId === currentVersionId;
            });

            if (!referencedByJob) {
              const touchedPaths = [...new Set([...changedPaths, ...deletedPaths])];
              const existingVerFiles =
                touchedPaths.length > 0
                  ? await tx
                      .select({
                        path: projectVersionFiles.path,
                        blobScope: projectVersionFiles.blobScope,
                        sha256: projectVersionFiles.sha256,
                      })
                      .from(projectVersionFiles)
                      .where(
                        and(
                          eq(projectVersionFiles.workspaceId, ctx.workspaceId),
                          eq(projectVersionFiles.versionId, currentVersionId),
                          inArray(projectVersionFiles.path, touchedPaths),
                        ),
                      )
                  : [];

              const touchedVersionFiles = new Map<string, { blobScope: BlobScope; sha256: string }>();
              for (const row of existingVerFiles) {
                touchedVersionFiles.set(row.path, {
                  blobScope: row.blobScope,
                  sha256: row.sha256.trim(),
                });
              }

              coalesceTarget = {
                versionId: currentVersionId,
                historyEntryId: headEntry.id,
                touchedVersionFiles,
              };
            }
          }
        }
      }

      // 6. Compute net workspace CAS blob refcount deltas across live project_files + version snapshot (or coalesced delta).
      const deltas: BlobRefDelta[] = [];

      if (hasFileChanges) {
        for (const filePath of deletedPaths) {
          const oldFile = currentByPath.get(filePath);
          if (oldFile && oldFile.blobScope === 'workspace') {
            deltas.push({ sha256: oldFile.sha256, delta: -1 });
          }
        }
        for (const filePath of changedPaths) {
          const oldFile = currentByPath.get(filePath);
          if (oldFile && oldFile.blobScope === 'workspace') {
            deltas.push({ sha256: oldFile.sha256, delta: -1 });
          }
          const newFile = nextByPath.get(filePath);
          if (newFile && newFile.blobScope === 'workspace') {
            deltas.push({
              sha256: newFile.sha256,
              delta: 1,
              sizeBytes: newFile.sizeBytes,
              mimeType: newFile.mimeType,
              s3Key: workspaceBlobKey(ctx.workspaceId, newFile.sha256),
              metadata: metadataBySha.get(newFile.sha256),
            });
          }
        }
      }

      if (shouldCreateVersion) {
        if (coalesceTarget) {
          for (const filePath of deletedPaths) {
            const oldVer = coalesceTarget.touchedVersionFiles.get(filePath);
            if (oldVer && oldVer.blobScope === 'workspace') {
              deltas.push({ sha256: oldVer.sha256, delta: -1 });
            }
          }
          for (const filePath of changedPaths) {
            const oldVer = coalesceTarget.touchedVersionFiles.get(filePath);
            if (oldVer && oldVer.blobScope === 'workspace') {
              deltas.push({ sha256: oldVer.sha256, delta: -1 });
            }
            const newFile = nextByPath.get(filePath);
            if (newFile && newFile.blobScope === 'workspace') {
              deltas.push({
                sha256: newFile.sha256,
                delta: 1,
                sizeBytes: newFile.sizeBytes,
                mimeType: newFile.mimeType,
                s3Key: workspaceBlobKey(ctx.workspaceId, newFile.sha256),
                metadata: metadataBySha.get(newFile.sha256),
              });
            }
          }
        } else {
          for (const newFile of nextByPath.values()) {
            if (newFile.blobScope === 'workspace') {
              deltas.push({
                sha256: newFile.sha256,
                delta: 1,
                sizeBytes: newFile.sizeBytes,
                mimeType: newFile.mimeType,
                s3Key: workspaceBlobKey(ctx.workspaceId, newFile.sha256),
                metadata: metadataBySha.get(newFile.sha256),
              });
            }
          }
        }
      }

      if (deltas.length > 0) {
        await applyWorkspaceBlobRefDeltas(tx, ctx.workspaceId, deltas);
      }

      // 7. Persist live project_files diff.
      if (deletedPaths.size > 0) {
        await tx
          .delete(projectFiles)
          .where(
            and(
              eq(projectFiles.workspaceId, ctx.workspaceId),
              eq(projectFiles.projectId, project.id),
              inArray(projectFiles.path, [...deletedPaths]),
            ),
          );
      }

      for (const filePath of changedPaths) {
        const entry = nextByPath.get(filePath);
        if (!entry) continue;
        await tx
          .insert(projectFiles)
          .values(
            asInsert(projectFiles, {
              workspaceId: ctx.workspaceId,
              projectId: project.id,
              path: entry.path,
              blobScope: entry.blobScope,
              sha256: entry.sha256,
              sizeBytes: entry.sizeBytes,
              mimeType: entry.mimeType,
              isText: entry.isText,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [projectFiles.projectId, projectFiles.path],
            set: asUpdate(projectFiles, {
              blobScope: entry.blobScope,
              sha256: entry.sha256,
              sizeBytes: entry.sizeBytes,
              mimeType: entry.mimeType,
              isText: entry.isText,
              updatedAt: now,
            }),
          });
      }

      // 8. Recompute canonical revision matching WorkspaceStore.revision().
      const nextRevision = computeProjectRevision(
        [...nextByPath.values()].map((f) => ({
          path: f.path,
          size: f.sizeBytes,
          hash: f.sha256,
        })),
      );

      let nextVersionId = currentVersionId;
      let nextVersionNumber = project.currentVersionNumber;
      let nextHistorySeq = project.currentHistorySeq;
      let coalesced = false;

      // 9. Coalesce in-place (delta only) OR append brand-new immutable snapshot.
      if (shouldCreateVersion && coalesceTarget) {
        if (deletedPaths.size > 0) {
          await tx
            .delete(projectVersionFiles)
            .where(
              and(
                eq(projectVersionFiles.workspaceId, ctx.workspaceId),
                eq(projectVersionFiles.versionId, coalesceTarget.versionId),
                inArray(projectVersionFiles.path, [...deletedPaths]),
              ),
            );
        }

        for (const filePath of changedPaths) {
          const entry = nextByPath.get(filePath);
          if (!entry) continue;
          await tx
            .insert(projectVersionFiles)
            .values(
              asInsert(projectVersionFiles, {
                versionId: coalesceTarget.versionId,
                workspaceId: ctx.workspaceId,
                projectId: project.id,
                path: entry.path,
                blobScope: entry.blobScope,
                sha256: entry.sha256,
                sizeBytes: entry.sizeBytes,
                mimeType: entry.mimeType,
              }),
            )
            .onConflictDoUpdate({
              target: [projectVersionFiles.versionId, projectVersionFiles.path],
              set: asUpdate(projectVersionFiles, {
                blobScope: entry.blobScope,
                sha256: entry.sha256,
                sizeBytes: entry.sizeBytes,
                mimeType: entry.mimeType,
              }),
            });
        }

        await tx
          .update(projectVersions)
          .set(
            asUpdate(projectVersions, {
              revision: nextRevision,
              summary,
              createdAt: now,
            }),
          )
          .where(
            and(
              eq(projectVersions.workspaceId, ctx.workspaceId),
              eq(projectVersions.projectId, project.id),
              eq(projectVersions.id, coalesceTarget.versionId),
            ),
          );

        await tx
          .update(projectHistoryEntries)
          .set(
            asUpdate(projectHistoryEntries, {
              label: summary,
              endedAt: now,
              ...(safeWindowId ? { windowId: safeWindowId } : {}),
            }),
          )
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
              eq(projectHistoryEntries.id, coalesceTarget.historyEntryId),
            ),
          );

        nextVersionId = coalesceTarget.versionId;
        coalesced = true;
      } else if (shouldCreateVersion) {
        const maxVerRow = await tx
          .select({ maxVer: sql<number>`COALESCE(MAX(${projectVersions.versionNumber}), 0)` })
          .from(projectVersions)
          .where(
            and(
              eq(projectVersions.workspaceId, ctx.workspaceId),
              eq(projectVersions.projectId, project.id),
            ),
          );
        nextVersionNumber = Math.max(project.currentVersionNumber, Number(maxVerRow[0]?.maxVer ?? 0)) + 1;

        const maxSeqRow = await tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${projectHistoryEntries.seq}), 0)` })
          .from(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
            ),
          );
        const maxSeq = Number(maxSeqRow[0]?.maxSeq ?? project.currentHistorySeq);
        nextHistorySeq = Math.max(project.currentHistorySeq, maxSeq) + 1;

        const parentRows =
          project.currentHistorySeq > 0
            ? await tx
                .select({ id: projectHistoryEntries.id })
                .from(projectHistoryEntries)
                .where(
                  and(
                    eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
                    eq(projectHistoryEntries.projectId, project.id),
                    eq(projectHistoryEntries.seq, project.currentHistorySeq),
                  ),
                )
            : [];
        const parentEntryId = parentRows[0]?.id ?? null;

        const insertedVersions = await tx
          .insert(projectVersions)
          .values(
            asInsert(projectVersions, {
              workspaceId: ctx.workspaceId,
              projectId: project.id,
              versionNumber: nextVersionNumber,
              revision: nextRevision,
              source: effectiveSource,
              summary,
              requestId: input.requestId ?? null,
              pinned: false,
              createdAt: now,
            }),
          )
          .returning({ id: projectVersions.id });
        const createdVersion = insertedVersions[0];
        if (!createdVersion) {
          throw new CloudError('STORAGE_ERROR', 'Failed to insert project version row.', { status: 500 });
        }
        nextVersionId = createdVersion.id;

        const snapshotValues = [...nextByPath.values()].map((f) =>
          asInsert(projectVersionFiles, {
            versionId: createdVersion.id,
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            path: f.path,
            blobScope: f.blobScope,
            sha256: f.sha256,
            sizeBytes: f.sizeBytes,
            mimeType: f.mimeType,
          }),
        );
        if (snapshotValues.length > 0) {
          await tx.insert(projectVersionFiles).values(snapshotValues);
        }

        // Clear abandoned future redo entries so a new forward edit starts a clean linear stack
        // without touching immutable project_versions / project_version_files snapshots or CAS refcounts.
        await tx
          .delete(projectHistoryEntries)
          .where(
            and(
              eq(projectHistoryEntries.workspaceId, ctx.workspaceId),
              eq(projectHistoryEntries.projectId, project.id),
              eq(projectHistoryEntries.undone, true),
              gt(projectHistoryEntries.seq, project.currentHistorySeq),
            ),
          );

        await tx.insert(projectHistoryEntries).values(
          asInsert(projectHistoryEntries, {
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            seq: nextHistorySeq,
            versionId: createdVersion.id,
            parentEntryId,
            actorKind: actor.actorKind,
            actorName: actor.actorName,
            label: summary,
            windowId: safeWindowId,
            pinned: false,
            undone: false,
            startedAt: now,
            endedAt: now,
          }),
        );
      }

      // 10. Update project header row.
      if (hasFileChanges || shouldCreateVersion || hasProjectUpdates) {
        await tx
          .update(projects)
          .set(
            asUpdate(projects, {
              revision: nextRevision,
              currentVersionId: nextVersionId,
              currentVersionNumber: nextVersionNumber,
              currentHistorySeq: nextHistorySeq,
              ...(input.projectUpdates?.namingLanguage !== undefined
                ? { namingLanguage: input.projectUpdates.namingLanguage }
                : {}),
              ...(input.projectUpdates?.requirements !== undefined
                ? { requirements: input.projectUpdates.requirements }
                : {}),
              ...(input.projectUpdates?.title !== undefined ? { title: input.projectUpdates.title } : {}),
              updatedAt: now,
            }),
          )
          .where(and(eq(projects.id, project.id), eq(projects.workspaceId, ctx.workspaceId)));
      }

      const sortedChanged = [...changedPaths].sort((a, b) => a.localeCompare(b));
      const sortedDeleted = [...deletedPaths].sort((a, b) => a.localeCompare(b));
      const impact = computePreviewImpact([...sortedChanged, ...sortedDeleted]);

      const versionsByPath: Record<string, string> = {};
      for (const filePath of sortedChanged) {
        const entry = nextByPath.get(filePath);
        if (entry) {
          versionsByPath[filePath] = formatVersionFromSha256(entry.sha256);
        }
      }

      const commitResult: CommitProjectFilesResult = {
        projectId: project.id,
        revision: nextRevision,
        versionId: nextVersionId,
        versionNumber: nextVersionNumber,
        historySeq: nextHistorySeq,
        changedPaths: sortedChanged,
        deletedPaths: sortedDeleted,
        versionsByPath,
        writeToken,
        affectsPreview: impact.affectsPreview,
        // The Studio file tree lists compositions by path. Editing existing HTML only changes its content.
        fileTreeChanged: sortedDeleted.length > 0 ||
          sortedChanged.some(path => !currentByPath.has(path) || !/\.html?$/i.test(path)),
        affectedCompositions: impact.affectedCompositions,
        replayed: false,
        ...(input.commandReceipt && { commandResult: input.commandReceipt.result }),
        coalesced,
      };

      // 11. Persist idempotency receipt on commit.
      if (input.requestId && inputHash) {
        await tx
          .insert(idempotencyReceipts)
          .values(
            asInsert(idempotencyReceipts, {
              workspaceId: ctx.workspaceId,
              scope,
              requestId: input.requestId,
              inputHash,
              state: 'completed',
              resourceId: nextVersionId,
              responsePayload: commitResult as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          )
          .onConflictDoUpdate({
            target: [idempotencyReceipts.workspaceId, idempotencyReceipts.scope, idempotencyReceipts.requestId],
            set: asUpdate(idempotencyReceipts, {
              state: 'completed',
              resourceId: nextVersionId,
              responsePayload: commitResult as unknown as Record<string, unknown>,
              updatedAt: now,
            }),
          });
      }

      return commitResult;
    });
  }
}

function buildAutoSummary(changedPaths: readonly string[], deletedPaths: readonly string[]): string {
  const total = changedPaths.length + deletedPaths.length;
  if (total === 0) return 'Checkpoint';
  if (changedPaths.length === 1 && deletedPaths.length === 0) {
    return `Edited ${changedPaths[0]}`;
  }
  if (deletedPaths.length === 1 && changedPaths.length === 0) {
    return `Deleted ${deletedPaths[0]}`;
  }
  return `Updated ${total} file${total === 1 ? '' : 's'}`;
}
