import { commitCaptionCommand } from '../mcp/caption-mutations.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { serve, type ServerType } from '@hono/node-server';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Redis } from 'ioredis';
import {
  catalogEntry,
  catalogPoster,
  catalogShowcase,
  catalogStyleCover,
  readBrandCatalog,
} from '../../gateway/brand-catalog.ts';
import { publicDesignFiles, resolveDesignSystemFile } from '../../packages/design-system/index.js';
import {
  buildBrowserObservabilityConfig,
  injectRuntimeConfigIntoHtml,
} from '../../packages/observability/config.ts';
import { compositionCanvasSource, type CanvasFit, type CanvasRatio } from '../../shared/composition-canvas.ts';
import {
  agentGuide,
  buildCloudIntegrationInfo,
  integrationConfig,
  integrationHost,
} from '../../shared/integration.ts';
import { loadLibrarySkills, skillNextStep } from '../../shared/library-skill-catalog.ts';
import { phase1McpCapabilities, phase1Tools } from '../../shared/phase1-tools.ts';
import { isUuid, validateStableRequestId } from '../../shared/project-validation.ts';
import { loadCaptionSourceOperations } from '../../shared/transcript-captions.ts';
import { VERSION } from '../../shared/version.ts';
import {
  providerSettingsPreview,
  sessionPath,
  templateLibraryPreview,
} from '../../shared/workspace-url.ts';
import {
  AmrIdentityClient,
  InMemoryAuthCache,
  OidcService,
  amrIdentityClientFromAppConfig,
  buildOAuth21Config,
  createAuthMiddleware,
  createAuthRoutes,
  createDevTenantProvisioner,
  createPgAuthStore,
  createRedisAuthCache,
  getAuthContext,
  oidcConfigFromAppConfig,
  type AuthEnv,
  type AuthKeyValueCache,
  type AuthMiddlewareDeps,
  type AuthStore,
} from '../auth/index.ts';
import {
  PREVIEW_TOKEN_QUERY_PARAM,
  buildPreviewAuthContext,
  extractPreviewToken,
  previewAssetBase,
  resolvePreviewTokenSecret,
  signPreviewToken,
  verifyPreviewToken,
} from '../auth/preview-token.ts';
import { isAssetLease, renewAssetLease, resolveAssetWorkspace } from '../auth/preview-asset-lease.ts';
import { hasMinRole, hasScope, type AuthContext } from '../contracts/auth.ts';
import { CloudError, featureDeferredP2, isCloudError } from '../contracts/errors.ts';
import type { StoragePort } from '../contracts/storage.ts';
import { createDbHandle, type Database, type DbHandle } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import { jobs } from '../db/schema/jobs.ts';
import { projectGrants, projects } from '../db/schema/projects.ts';
import { getConfig, type AppConfig } from '../infra/config.ts';
import { createLogger, type Logger } from '../infra/logger.ts';
import { QueueService } from '../infra/queues.ts';
import {
  workspaceCatalogChannel,
  HotTextCache,
  RateLimiter,
  RedisEventBus,
  cancelChannel,
  createRedisClient,
} from '../infra/redis.ts';
import { ShutdownCoordinator } from '../infra/shutdown.ts';
import { StorageService, resolveCorsAllowedOrigins } from '../infra/storage.ts';
import {
  CloudImportAssetsService,
  InMemoryMcpSessionStore,
  McpToolDispatcher,
  RedisMcpSessionStore,
  createMcpHttpRoutes,
  createPgImportAssetsStore,
  type McpDomainPorts,
  type McpEventBusPort,
  type McpSessionStore,
} from '../mcp/index.ts';
import { createAccountRoutes } from '../routes/account.ts';
import { createArchivesRouter } from '../routes/archives.ts';
import { createAssetRoutes } from '../routes/assets.ts';
import { createCatalogRoutes } from '../routes/catalog.ts';
import { createExportRoutes } from '../routes/exports.ts';
import { createModelRoutes, type MediaJobPort } from '../routes/models.ts';
import { createProjectsRouter } from '../routes/projects.ts';
import { createSessionsRouter } from '../routes/sessions.ts';
import { AssetLibraryService } from '../services/asset-library-service.ts';
import { AssetNamesService } from '../services/asset-names-service.ts';
import { CatalogService } from '../services/catalog-service.ts';
import { ExportService } from '../services/export-service.ts';
import { createPlatformModelGateway, type PlatformModelGateway } from '../services/model-gateway.ts';
import { ProjectArchiveService } from '../services/project-archive-service.ts';
import { createOrCloneProject } from '../services/project-creation.ts';
import {
  ProjectFilesService,
  loadProjectOrThrow,
  type HotTextCachePort,
  type ProjectFileOp,
} from '../services/project-files-service.ts';
import { VersionHistoryService } from '../services/version-history-service.ts';
import { WelcomeBootstrapService } from '../services/welcome-bootstrap.ts';
import { WorkRoundsService } from '../services/work-rounds-service.ts';
import { WorkspaceService } from '../services/workspace-service.ts';
import {
  createDisklessStudioApp,
  type DisklessStudioDeps,
  type StudioEventBusPort,
  type StudioQueuesPort,
} from '../studio/index.ts';

const DEFAULT_RUNTIME_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_ACTIVE_MEDIA_GENERATIONS = 20;
const WELCOME_CACHE_LIMIT = 10_000;
const PREVIEW_PROJECT_PATH_RE = /^\/api\/projects\/([^/]+)\/preview(?:\/.*)?$/;
const PREVIEW_FONT_VIEWER_ID = '00000000-0000-4000-8000-000000000000';

export function resolveApiCorsAllowedOrigins(
  config: Pick<AppConfig, 'APP_PUBLIC_ORIGIN' | 'PREVIEW_PUBLIC_ORIGIN'>,
): string[] {
  return resolveCorsAllowedOrigins(
    config.APP_PUBLIC_ORIGIN,
    config.PREVIEW_PUBLIC_ORIGIN ? [config.PREVIEW_PUBLIC_ORIGIN] : [],
  );
}

function resolveIncomingRequestHost(request: Request, trustProxyHops: number): string {
  if (trustProxyHops > 0) {
    const forwardedHost = request.headers.get('x-forwarded-host');
    if (forwardedHost) {
      const first = forwardedHost.split(',')[0]?.trim().toLowerCase();
      if (first) return first;
    }
  }
  const hostHeader = request.headers.get('host')?.trim().toLowerCase();
  if (hostHeader) return hostHeader;
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeHostForOrigin(rawHost: string, expectedOrigin: URL): string {
  const lower = rawHost.trim().toLowerCase();
  if (expectedOrigin.protocol === 'https:' && lower.endsWith(':443')) {
    return lower.slice(0, -4);
  }
  if (expectedOrigin.protocol === 'http:' && lower.endsWith(':80')) {
    return lower.slice(0, -3);
  }
  return lower;
}

function applyIsolatedPreviewHeaders(
  response: Response,
  appOrigin: string,
  allowedCorsOrigins: ReadonlySet<string>,
  requestOrigin: string | null,
): Response {
  const apply = (headers: Headers): void => {
    headers.set('Content-Security-Policy', `frame-ancestors 'self' ${appOrigin};`);
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.delete('Set-Cookie');
    if (requestOrigin && allowedCorsOrigins.has(requestOrigin)) {
      headers.set('Access-Control-Allow-Origin', requestOrigin);
      const existingVary = headers.get('Vary');
      if (!existingVary) {
        headers.set('Vary', 'Origin');
      } else if (!existingVary.toLowerCase().includes('origin')) {
        headers.set('Vary', `${existingVary}, Origin`);
      }
    }
  };

  try {
    apply(response.headers);
    return response;
  } catch {
    const clonedHeaders = new Headers(response.headers);
    apply(clonedHeaders);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: clonedHeaders,
    });
  }
}

const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const ACTIVE_JOB_STATES = ['queued', 'running', 'cancelling'] as const;

export type ApiQueuesPort = StudioQueuesPort &
  Pick<QueueService, 'enqueueMediaIngest' | 'enqueueMediaGenerate' | 'enqueueRenderExport' | 'renderExport'>;

export type ApiEventBusPort = StudioEventBusPort &
  McpEventBusPort & {
    checkHealth?: () => Promise<boolean>;
  };

export interface CreateApiAppDeps {
  readonly config: AppConfig;
  readonly db: Database;
  readonly storage: StoragePort;
  readonly queues: ApiQueuesPort;
  readonly eventBus: ApiEventBusPort;
  readonly hotTextCache?: HotTextCachePort;
  readonly rateLimiter?: RateLimiter;
  readonly authStore?: AuthStore;
  readonly authCache?: AuthKeyValueCache;
  readonly oidc?: OidcService;
  readonly amrIdentity?: AmrIdentityClient;
  readonly gateway?: PlatformModelGateway;
  readonly mcpSessionStore?: McpSessionStore;
  readonly welcomeBootstrap?: WelcomeBootstrapService;
  readonly disableWelcomeBootstrap?: boolean;
  readonly requireBearerOnDevMcp?: boolean;
  readonly logger?: Logger;
  readonly runtimeRoot?: string;
  readonly fontsDir?: string;
  readonly checkDbHealth?: () => Promise<boolean>;
  readonly checkRedisHealth?: () => Promise<boolean>;
  readonly checkStorageHealth?: () => Promise<boolean>;
}

export interface ApiAppServices {
  readonly authStore: AuthStore;
  readonly gateway: PlatformModelGateway;
  readonly catalog: CatalogService;
  readonly welcomeBootstrap: WelcomeBootstrapService;
  readonly files: ProjectFilesService;
  readonly history: VersionHistoryService;
  readonly workspace: WorkspaceService;
  readonly assetNames: AssetNamesService;
  readonly workRounds: WorkRoundsService;
  readonly archives: ProjectArchiveService;
  readonly assets: AssetLibraryService;
  readonly exports: ExportService;
  readonly importAssets: CloudImportAssetsService;
  readonly mediaJobs: MediaJobPort;
  readonly mcpDispatcher: McpToolDispatcher;
}

export interface ApiServerHandle {
  readonly app: Hono<AuthEnv>;
  readonly services: ApiAppServices;
  readonly server: ServerType;
  readonly shutdown: ShutdownCoordinator;
  readonly port: number;
  readonly host: string;
  close(reason?: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Read-Only Static Asset Helpers (Design System, Studio SPA, MCP UI, GSAP)
// ---------------------------------------------------------------------------

function resolveSafeSubpath(rootDir: string, relativePath: string): string | null {
  const cleaned = relativePath.replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\\') || /[\x00-\x1f]/.test(cleaned)) {
    return null;
  }
  const parts = cleaned.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    return null;
  }
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, cleaned);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolvedTarget;
}

async function readStaticResponse(
  filePath: string,
  options: { cacheControl?: string; corsAll?: boolean; headOnly?: boolean } = {},
): Promise<Response | null> {
  const mimeType = STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()];
  if (!mimeType) return null;
  try {
    const bytes = await readFile(filePath);
    const headers = new Headers({
      'Content-Type': mimeType,
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
    });
    if (options.cacheControl) headers.set('Cache-Control', options.cacheControl);
    if (options.corsAll) headers.set('Access-Control-Allow-Origin', '*');
    return new Response(options.headOnly ? null : new Uint8Array(bytes), {
      status: 200,
      headers,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Pure read-only static handler for `/design-system/*`, `/web/design-system/*`,
 * `/favicon.svg`, `/editor-assets/*`, `/guide-assets/*`, `/web/catalog/*`,
 * `/web/inline-video.html`, `/mcp-ui/template-recommendations/*`, and `/api/vendor/gsap/*`.
 */
export async function serveStaticAsset(
  pathname: string,
  runtimeRoot = DEFAULT_RUNTIME_ROOT,
  headOnly = false,
  options: { allowSourcemaps?: boolean } = {},
): Promise<Response | null> {
  if (options.allowSourcemaps === false && pathname.toLowerCase().endsWith('.map')) {
    return null;
  }

  // 1. Design system package assets (supports both `/design-system/*` and `/web/design-system/*`).
  const designFile = resolveDesignSystemFile(pathname);
  if (designFile) {
    const target = resolveSafeSubpath(path.join(runtimeRoot, 'packages/design-system'), designFile);
    if (!target) return null;
    return readStaticResponse(target, {
      corsAll: /\.(?:ttf|woff2?)$/i.test(designFile),
      cacheControl: 'public, max-age=300',
      headOnly,
    });
  }

  // 2. Favicon
  if (pathname === '/favicon.svg') {
    return readStaticResponse(path.join(runtimeRoot, 'packages/design-system/brand/favicon.svg'), {
      cacheControl: 'public, max-age=3600',
      headOnly,
    });
  }

  // 3. Built Studio assets
  if (/^\/editor-assets\/[a-zA-Z0-9_.-]+$/.test(pathname) || /^\/guide-assets\/viewer\.(js|css)$/.test(pathname)) {
    const target = resolveSafeSubpath(path.join(runtimeRoot, 'studio/build'), pathname);
    if (!target) return null;
    const response = await readStaticResponse(target, {
      cacheControl: 'public, max-age=31536000, immutable',
      headOnly,
    });
    if (response) return response;
    return new Response('Studio bundle asset not found. Run npm run build:studio.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // 4. Web catalog static metadata & covers + inline-video player assets
  if (
    /^\/web\/catalog\/(?:hyperframes|template-frames|provenance|covers)\.json$/.test(pathname) ||
    /^\/web\/catalog\/(?:template-frames|covers)\/[a-f0-9]{24}\.(?:jpg|webp)$/.test(pathname) ||
    pathname === '/web/inline-video.html' ||
    pathname === '/web/inline-video.css' ||
    pathname === '/web/inline-video.js' ||
    pathname === '/web/inline-video-notices.txt' ||
    pathname === '/web/final-video-component.js'
  ) {
    const target = resolveSafeSubpath(runtimeRoot, pathname);
    if (!target) return null;
    return readStaticResponse(target, { cacheControl: 'public, max-age=300', headOnly });
  }

  // 5. MCP Apps template-recommendations bundle
  if (pathname.startsWith('/mcp-ui/template-recommendations/')) {
    const sub = pathname.slice('/mcp-ui/template-recommendations/'.length);
    if (/^(?:build|assets|project-previews)\//.test(sub) || sub === 'inline.fragment.html') {
      const target = resolveSafeSubpath(path.join(runtimeRoot, 'mcp-ui/template-recommendations'), sub);
      if (!target) return null;
      return readStaticResponse(target, { cacheControl: 'public, max-age=3600', headOnly });
    }
  }

  return null;
}

async function readGsapFile(runtimeRoot: string, fileName = 'gsap.min.js'): Promise<Buffer | null> {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName) || fileName.includes('..')) return null;
  try {
    const req = createRequire(path.resolve(runtimeRoot, 'package.json'));
    const gsapRoot = path.dirname(req.resolve('gsap/package.json'));
    const target = resolveSafeSubpath(path.join(gsapRoot, 'dist'), fileName);
    if (!target) return null;
    return await readFile(target);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Media Generation Job Port (PG `jobs` + BullMQ `media-generate` + Cancel Bus)
// ---------------------------------------------------------------------------

function createCloudMediaJobsPort(deps: {
  db: Database;
  queues: Pick<QueueService, 'enqueueMediaGenerate'>;
  eventBus: Pick<RedisEventBus, 'publish'>;
  assets: AssetLibraryService;
}): MediaJobPort & {
  handleMediaAction(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
} {
  const serializeJob = (row: typeof jobs.$inferSelect): Record<string, unknown> => {
    const input = (row.inputPayload ?? {}) as Record<string, unknown>;
    const result = (row.resultJson ?? {}) as Record<string, unknown>;
    const modality =
      input.modality === 'image' || input.modality === 'video' || input.modality === 'audio'
        ? input.modality
        : 'image';
    const mode =
      typeof input.mode === 'string' && input.mode
        ? input.mode
        : modality === 'video'
          ? 'text-to-video'
          : modality === 'audio'
            ? 'text-to-audio'
            : 'text-to-image';
    const modelId = typeof input.modelId === 'string' ? input.modelId : 'unknown';
    const fullModelId = modelId.startsWith('opendesign:') ? modelId : `opendesign:${modelId}`;
    const libraryAssets =
      typeof result.assetId === 'string' && typeof result.versionId === 'string'
        ? [{ assetId: result.assetId, versionId: result.versionId }]
        : [];
    return {
      id: row.id,
      jobId: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId ?? null,
      kind: row.kind,
      state: row.state,
      stage: row.stage ?? row.state,
      phase: row.stage ?? row.state,
      progress: Number(row.progress ?? 0),
      provider: 'opendesign',
      modality,
      mode,
      modelId,
      model: {
        id: fullModelId,
        provider: 'opendesign',
        modelId,
        label: modelId,
        modality,
        source: 'live',
        mode,
      },
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      parameters:
        input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
          ? (input.parameters as Record<string, unknown>)
          : {},
      requestHash: row.requestHash ?? '',
      idempotencyKey: row.idempotencyKey ?? row.requestId ?? undefined,
      saveToLibrary: true,
      assets: [],
      libraryAssets,
      remoteId: row.remoteId ?? null,
      savePending: row.savePending,
      requestId: row.requestId ?? null,
      ...(row.resultJson ? { result } : {}),
      ...(typeof result.assetId === 'string' ? { assetId: result.assetId } : {}),
      ...(typeof result.versionId === 'string' ? { versionId: result.versionId } : {}),
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(row.errorMessage ? { error: row.errorMessage } : {}),
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
      ...(row.terminalAt ? { terminalAt: row.terminalAt.toISOString() } : {}),
    };
  };

  const submitGeneration = async (
    auth: AuthContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const modality = input.modality;
    if (modality !== 'image' && modality !== 'video' && modality !== 'audio') {
      throw new CloudError('INVALID_ARGUMENT', 'modality must be image, video, or audio', {
        status: 400,
        applied: false,
      });
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > 20_000) {
      throw new CloudError('INVALID_ARGUMENT', 'prompt must contain 1-20000 characters', {
        status: 400,
        applied: false,
      });
    }
    const rawModel = typeof input.model === 'string' ? input.model.trim() : typeof input.modelId === 'string' ? input.modelId.trim() : '';
    if (!rawModel) {
      throw new CloudError('INVALID_ARGUMENT', 'model is required', { status: 400, applied: false });
    }
    const modelId = rawModel.replace(/^opendesign:/, '');
    const mode =
      input.mode === 'text-to-image' ||
      input.mode === 'text-to-video' ||
      input.mode === 'text-to-audio' ||
      input.mode === 'text-to-speech'
        ? input.mode
        : modality === 'image'
          ? 'text-to-image'
          : modality === 'video'
            ? 'text-to-video'
            : 'text-to-audio';

    const requestId =
      typeof input.requestId === 'string' && input.requestId.trim()
        ? validateStableRequestId(input.requestId)
        : randomUUID();
    const projectId = typeof input.projectId === 'string' && isUuid(input.projectId) ? input.projectId : null;
    if (projectId && auth.authMethod === 'oauth_bearer') {
      await loadProjectOrThrow(deps.db, auth.workspaceId, projectId, { allowTrashed: false, auth });
    }
    const assetName =
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim().slice(0, 200)
        : prompt.slice(0, 80);
    const parameters =
      input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
        ? (input.parameters as Record<string, unknown>)
        : {};

    const rawRefs = Array.isArray(input.references) ? input.references : [];
    const resolvedRefs =
      rawRefs.length > 0
        ? await deps.assets.resolveReferences(
            auth,
            rawRefs
              .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
              .map((r) => ({
                assetId: String(r.assetId ?? ''),
                versionId: String(r.versionId ?? ''),
                role:
                  r.role === 'first_frame' || r.role === 'last_frame' || r.role === 'reference'
                    ? r.role
                    : undefined,
              })),
          )
        : [];

    const requestHash = createHash('sha256')
      .update(JSON.stringify({ modality, mode, modelId, prompt, parameters, projectId, resolvedRefs }))
      .digest('hex');

    // Check existing idempotency key first
    const [existing] = await deps.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, auth.workspaceId),
          eq(jobs.kind, 'media_generate'),
          eq(jobs.idempotencyKey, requestId),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw new CloudError(
          'REQUEST_ID_CONFLICT',
          'requestId was already used for a different generation request',
          { status: 409, applied: false },
        );
      }
      return { job: serializeJob(existing), replayed: true };
    }

    const activeRows = await deps.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, auth.workspaceId),
          eq(jobs.kind, 'media_generate'),
          inArray(jobs.state, [...ACTIVE_JOB_STATES]),
        ),
      );
    if (activeRows.length >= MAX_ACTIVE_MEDIA_GENERATIONS) {
      throw new CloudError(
        'RATE_LIMITED',
        `Workspace already has ${MAX_ACTIVE_MEDIA_GENERATIONS} active media generation jobs.`,
        { status: 429, applied: false },
      );
    }

    const jobId = randomUUID();
    const inputPayload: Record<string, unknown> = {
      modality,
      mode,
      modelId,
      prompt,
      parameters,
      assetName,
      ...(typeof input.assetId === 'string' && isUuid(input.assetId) ? { assetId: input.assetId } : {}),
      ...(typeof input.parentVersionId === 'string' && isUuid(input.parentVersionId)
        ? { parentVersionId: input.parentVersionId }
        : {}),
      references: resolvedRefs,
      ...(auth.externalWorkspaceId ? { externalWorkspaceId: auth.externalWorkspaceId } : {}),
      externalUserId: auth.authUserId ?? auth.userId,
      ...(auth.appUserId ? { appUserId: auth.appUserId } : {}),
      ...(auth.amrWorkspaceMemberId ? { amrWorkspaceMemberId: auth.amrWorkspaceMemberId } : {}),
      ...(auth.amrWorkspaceRole ? { amrWorkspaceRole: auth.amrWorkspaceRole } : {}),
      ...(auth.amrWorkspaceLifecycleState
        ? { amrWorkspaceLifecycleState: auth.amrWorkspaceLifecycleState }
        : {}),
    };

    const [inserted] = await deps.db
      .insert(jobs)
      .values(
        asInsert(jobs, {
          id: jobId,
          workspaceId: auth.workspaceId,
          projectId,
          kind: 'media_generate',
          state: 'queued',
          stage: 'queued',
          requestId,
          idempotencyKey: requestId,
          requestHash,
          inputPayload,
        }),
      )
      .returning();

    try {
      await deps.queues.enqueueMediaGenerate('generate_media', {
        jobId,
        workspaceId: auth.workspaceId,
      });
    } catch (error) {
      await deps.db
        .update(jobs)
        .set(
          asUpdate(jobs, {
            state: 'failed',
            stage: 'failed',
            failureStage: 'enqueue',
            errorCode: 'QUEUE_ENQUEUE_FAILED',
            errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Failed to enqueue media generation',
            terminalAt: sql`now()`,
            updatedAt: sql`now()`,
          }),
        )
        .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)));
      throw new CloudError('SERVICE_UNAVAILABLE', 'Could not enqueue media generation job', {
        status: 503,
        applied: false,
      });
    }

    return { job: serializeJob(inserted), replayed: false };
  };

  const listJobs = async (
    auth: AuthContext,
    query: { projectId?: string; limit?: number; offset?: number },
  ): Promise<Record<string, unknown>> => {
    const limit = Math.min(Math.max(1, query.limit ?? 50), 100);
    const offset = Math.max(0, query.offset ?? 0);
    const rawProjectId = typeof query.projectId === 'string' ? query.projectId.trim() : '';

    if (auth.authMethod === 'oauth_bearer') {
      if (rawProjectId) {
        if (!isUuid(rawProjectId)) {
          return { jobs: [], total: 0, offset, limit };
        }
        await loadProjectOrThrow(deps.db, auth.workspaceId, rawProjectId, { allowTrashed: true, auth });
        const rows = await deps.db
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.workspaceId, auth.workspaceId),
              eq(jobs.kind, 'media_generate'),
              eq(jobs.projectId, rawProjectId),
            ),
          )
          .orderBy(desc(jobs.createdAt))
          .limit(limit)
          .offset(offset);
        return {
          jobs: rows.map(serializeJob),
          total: rows.length,
          offset,
          limit,
        };
      }

      if (!auth.clientId) {
        return { jobs: [], total: 0, offset, limit };
      }

      const grantedRows = await deps.db
        .select({ projectId: projectGrants.projectId })
        .from(projectGrants)
        .where(
          and(
            eq(projectGrants.workspaceId, auth.workspaceId),
            eq(projectGrants.userId, auth.userId),
            eq(projectGrants.clientId, auth.clientId),
            isNull(projectGrants.revokedAt),
          ),
        );

      const candidateProjectIds = [...new Set(grantedRows.map((row) => row.projectId))];
      if (candidateProjectIds.length === 0) {
        return { jobs: [], total: 0, offset, limit };
      }

      const accessibleProjects = await deps.db
        .select({ id: projects.id, ownerUserId: projects.ownerUserId })
        .from(projects)
        .where(and(eq(projects.workspaceId, auth.workspaceId), inArray(projects.id, candidateProjectIds)));

      const grantedProjectIds = accessibleProjects
        .filter((project) => !project.ownerUserId || project.ownerUserId === auth.userId)
        .map((project) => project.id);
      if (grantedProjectIds.length === 0) {
        return { jobs: [], total: 0, offset, limit };
      }

      const rows = await deps.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.workspaceId, auth.workspaceId),
            eq(jobs.kind, 'media_generate'),
            inArray(jobs.projectId, grantedProjectIds),
          ),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        jobs: rows.map(serializeJob),
        total: rows.length,
        offset,
        limit,
      };
    }

    const predicate =
      rawProjectId && isUuid(rawProjectId)
        ? and(
            eq(jobs.workspaceId, auth.workspaceId),
            eq(jobs.kind, 'media_generate'),
            eq(jobs.projectId, rawProjectId),
          )
        : and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.kind, 'media_generate'));

    const rows = await deps.db
      .select()
      .from(jobs)
      .where(predicate)
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      jobs: rows.map(serializeJob),
      total: rows.length,
      offset,
      limit,
    };
  };

  const getJob = async (auth: AuthContext, jobId: string): Promise<Record<string, unknown>> => {
    if (!isUuid(jobId)) {
      throw new CloudError('NOT_FOUND', `Media job '${jobId}' not found`, { status: 404, applied: false });
    }
    const [row] = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId), eq(jobs.kind, 'media_generate')))
      .limit(1);
    if (!row) {
      throw new CloudError('NOT_FOUND', `Media job '${jobId}' not found`, { status: 404, applied: false });
    }
    if (row.projectId && auth.authMethod === 'oauth_bearer') {
      await loadProjectOrThrow(deps.db, auth.workspaceId, row.projectId, { allowTrashed: true, auth });
    }
    return { job: serializeJob(row) };
  };

  const cancelJob = async (auth: AuthContext, jobId: string): Promise<Record<string, unknown>> => {
    if (!isUuid(jobId)) {
      throw new CloudError('NOT_FOUND', `Media job '${jobId}' not found`, { status: 404, applied: false });
    }
    const [existing] = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId), eq(jobs.kind, 'media_generate')))
      .limit(1);
    if (!existing) {
      throw new CloudError('NOT_FOUND', `Media job '${jobId}' not found`, { status: 404, applied: false });
    }
    if (existing.projectId && auth.authMethod === 'oauth_bearer') {
      await loadProjectOrThrow(deps.db, auth.workspaceId, existing.projectId, { allowTrashed: true, auth });
    }
    if (['completed', 'failed', 'cancelled'].includes(existing.state)) {
      return { job: serializeJob(existing) };
    }
    const nextState = existing.state === 'queued' ? 'cancelled' : 'cancelling';
    const [updated] = await deps.db
      .update(jobs)
      .set(
        asUpdate(jobs, {
          state: nextState,
          stage: nextState,
          ...(nextState === 'cancelled' ? { terminalAt: sql`now()` } : {}),
          updatedAt: sql`now()`,
        }),
      )
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)))
      .returning();

    await deps.eventBus.publish(cancelChannel(jobId), {
      jobId,
      workspaceId: auth.workspaceId,
      requestedAt: Date.now(),
    });
    return { job: serializeJob(updated ?? existing) };
  };

  const resumeJob = async (
    auth: AuthContext,
    jobId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> => {
    validateStableRequestId(requestId);
    if (!isUuid(jobId)) {
      throw new CloudError('NOT_FOUND', `Media job '${jobId}' not found`, { status: 404, applied: false });
    }
    const [existing] = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId), eq(jobs.kind, 'media_generate')))
      .limit(1);
    if (!existing) {
      throw new CloudError('NOT_FOUND', `Media job '${jobId}' not found`, { status: 404, applied: false });
    }
    if (existing.projectId && auth.authMethod === 'oauth_bearer') {
      await loadProjectOrThrow(deps.db, auth.workspaceId, existing.projectId, { allowTrashed: true, auth });
    }
    if (!existing.remoteId || existing.remoteTerminal || existing.state !== 'failed') {
      throw new CloudError(
        'INVALID_ARGUMENT',
        'Only failed media jobs with an active upstream remoteId can be resumed without re-submitting.',
        { status: 409, applied: false },
      );
    }

    const [updated] = await deps.db
      .update(jobs)
      .set(
        asUpdate(jobs, {
          state: 'queued',
          stage: 'resuming',
          errorCode: null,
          errorMessage: null,
          terminalAt: null,
          updatedAt: sql`now()`,
        }),
      )
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId)))
      .returning();

    await deps.queues.enqueueMediaGenerate(
      'resume_generation',
      {
        jobId,
        workspaceId: auth.workspaceId,
        remoteId: existing.remoteId,
      },
      { jobId: `${jobId}__resume__${requestId}` },
    );

    return { job: serializeJob(updated ?? existing) };
  };

  const retrySaveJob = async (auth: AuthContext, jobId: string): Promise<Record<string, unknown>> => {
    if (!isUuid(jobId)) {
      throw new CloudError('NOT_FOUND', `Media job '${jobId}' not found`, { status: 404, applied: false });
    }
    const [existing] = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.workspaceId, auth.workspaceId), eq(jobs.id, jobId), eq(jobs.kind, 'media_generate')))
      .limit(1);
    if (!existing) {
      throw new CloudError('NOT_FOUND', `Media job '${jobId}' not found`, { status: 404, applied: false });
    }
    if (existing.projectId && auth.authMethod === 'oauth_bearer') {
      await loadProjectOrThrow(deps.db, auth.workspaceId, existing.projectId, { allowTrashed: true, auth });
    }
    if (!existing.savePending) {
      throw new CloudError('INVALID_ARGUMENT', 'Media job does not have a pending save to retry.', {
        status: 409,
        applied: false,
      });
    }
    await deps.queues.enqueueMediaGenerate(
      'retry_save_generation',
      { jobId, workspaceId: auth.workspaceId },
      { jobId: `${jobId}__retry_save__${Date.now()}` },
    );
    return { job: serializeJob(existing) };
  };

  const handleMediaAction = async (
    auth: AuthContext,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const action = String(args.action ?? '');
    switch (action) {
      case 'generate':
        return submitGeneration(auth, args);
      case 'jobs':
        return listJobs(auth, {
          projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          offset: typeof args.offset === 'number' ? args.offset : undefined,
        });
      case 'status':
        return getJob(auth, String(args.jobId ?? ''));
      case 'cancel':
        return cancelJob(auth, String(args.jobId ?? ''));
      case 'resume':
        return resumeJob(auth, String(args.jobId ?? ''), String(args.requestId ?? ''));
      case 'retry_save':
        return retrySaveJob(auth, String(args.jobId ?? ''));
      default:
        throw new CloudError('INVALID_ARGUMENT', `Unsupported media action '${action}'`, {
          status: 400,
          applied: false,
        });
    }
  };

  return {
    submitGeneration,
    listJobs,
    getJob,
    cancelJob,
    resumeJob,
    handleMediaAction,
  };
}

// ---------------------------------------------------------------------------
// Complete `McpDomainPorts` Adapter Wiring All 22 Registered `openmotion_*` Tools
// ---------------------------------------------------------------------------

function buildProjectPreviewHandoff(
  publicOrigin: string,
  project: { id: string; sessionId: string; revision: string; currentVersionId: string | null },
  options: { embedded?: boolean; presentation?: string } = {},
) {
  const origin = publicOrigin.replace(/\/$/, '');
  const embedded = options.embedded !== false;
  const previewUrl = origin + sessionPath(project.sessionId, project.id, { openArtifact: true, embedded });
  const sessionUrl = origin + sessionPath(project.sessionId, project.id, { openArtifact: true, embedded: false });
  const presentation = options.presentation ?? 'foreground';
  const background = presentation === 'background';

  return {
    previewUrl,
    sessionUrl,
    previewHandoff: {
      target: 'project',
      projectId: project.id,
      sessionId: project.sessionId,
      revision: project.revision,
      versionId: project.currentVersionId,
      previewUrl,
      sessionUrl,
      placement: 'right',
      reuseExistingTab: true,
      presentation,
      focusPolicy: background
        ? 'background'
        : presentation === 'now'
          ? 'switch_to_calling_chat'
          : 'preserve_current_chat',
      state: background ? 'background' : 'pending',
      openedByHost: false,
      hostActionRequired: !background,
      nextAction: background
        ? null
        : {
            kind: 'tool',
            tool: 'openmotion_open_preview',
            arguments: { projectId: project.id },
          },
      instructions:
        'Follow openmotion://workflow/production/native before delivering. Open previewUrl in the host browser or present the verified export.',
    },
  };
}

function createMcpDomainPorts(deps: {
  config: AppConfig;
  runtimeRoot: string;
  authStore: AuthStore;
  workspace: WorkspaceService;
  files: ProjectFilesService;
  history: VersionHistoryService;
  catalog: CatalogService;
  assets: AssetLibraryService;
  exports: ExportService;
  workRounds: WorkRoundsService;
  assetNames: AssetNamesService;
  archives: ProjectArchiveService;
  importAssets: CloudImportAssetsService;
  gateway: PlatformModelGateway;
  mediaJobs: MediaJobPort & {
    handleMediaAction(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
}): McpDomainPorts {
  let cachedCaptionOps: Awaited<ReturnType<typeof loadCaptionSourceOperations>> | null = null;
  const getCaptionOps = async () => {
    if (!cachedCaptionOps) {
      cachedCaptionOps = await loadCaptionSourceOperations(deps.runtimeRoot);
    }
    return cachedCaptionOps;
  };

  return {
    projects: {
      async getProject(auth, args) {
        const projectId = typeof args.projectId === 'string' ? args.projectId : undefined;
        if (!projectId) {
          const catalog = await deps.workspace.getCatalog(auth);
          const list = args.trashed === true ? catalog.trashedProjects : catalog.projects;
          const pageSize = 5;
          let offset = 0;
          if (typeof args.cursor === 'string' && args.cursor.trim()) {
            const parsed = Number.parseInt(args.cursor, 10);
            if (Number.isSafeInteger(parsed) && parsed >= 0) offset = parsed;
          }
          const slice = list.slice(offset, offset + pageSize);
          const nextCursor = offset + pageSize < list.length ? String(offset + pageSize) : null;
          return {
            workspaceId: auth.workspaceId,
            activeId: catalog.activeId,
            trashed: args.trashed === true,
            total: list.length,
            projects: slice,
            nextCursor,
          };
        }

        const project = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
        if (typeof args.expectedRevision === 'string' && project.revision !== args.expectedRevision) {
          throw new CloudError('VERSION_CONFLICT', 'Project revision does not match expectedRevision', {
            status: 409,
            applied: false,
            details: { currentRevision: project.revision, currentVersionId: project.currentVersionId },
          });
        }

        const virtual = await deps.files.loadVirtualProject(auth, project.id);
        const allFiles = virtual.listFiles();
        const assetNames = await deps.assetNames.readAssetNames(auth, project.id, {
          paths: allFiles.map((f) => f.path),
        });

        let fileContent: Record<string, unknown> | undefined;
        if (args.file && typeof args.file === 'object') {
          const fileReq = args.file as { path: string; offset?: number; length?: number };
          const read = await deps.files.readTextFile(auth, project.id, fileReq.path);
          if (!read) {
            throw new CloudError('NOT_FOUND', `File '${fileReq.path}' not found in project`, {
              status: 404,
              applied: false,
            });
          }
          const offset = Math.max(0, fileReq.offset ?? 0);
          const length = Math.min(2 * 1024 * 1024, Math.max(1, fileReq.length ?? 200_000));
          const sliced = read.content.slice(offset, offset + length);
          fileContent = {
            path: read.file.path,
            offset,
            length: sliced.length,
            totalLength: read.content.length,
            truncated: offset + sliced.length < read.content.length,
            content: sliced,
          };
        }

        let exportJob: Record<string, unknown> | undefined;
        if (typeof args.exportJobId === 'string') {
          const job = await deps.exports.getExport(auth, args.exportJobId);
          let downloadUrl: string | undefined;
          if (job.state === 'completed') {
            const presigned = await deps.exports
              .presignExportFile(auth, job.id, { disposition: 'inline' })
              .catch(() => null);
            downloadUrl = presigned?.url;
          }
          exportJob = { ...job, ...(downloadUrl ? { downloadUrl } : {}) };
        }

        let inlineWork: Record<string, unknown> | undefined;
        if (typeof args.workId === 'string') {
          const round = await deps.workRounds.get(auth, project.id, args.workId);
          if (!round) {
            throw new CloudError('NOT_FOUND', `Work round '${args.workId}' not found`, {
              status: 404,
              applied: false,
            });
          }
          let videoUrl: string | undefined;
          let playable = false;
          if (round.jobId) {
            const job = await deps.exports.getExport(auth, round.jobId).catch(() => null);
            if (job && job.state === 'completed') {
              playable = true;
              if (args.includeVideo === true) {
                const presigned = await deps.exports
                  .presignExportFile(auth, job.id, { disposition: 'inline' })
                  .catch(() => null);
                videoUrl = presigned?.url;
              }
            }
          }
          inlineWork = {
            ...round,
            playable,
            ...(playable ? { state: 'completed' } : {}),
            ...(videoUrl ? { videoUrl } : {}),
          };
        }

        return {
          projectId: project.id,
          sessionId: project.sessionId,
          project,
          revision: project.revision,
          currentVersionId: project.currentVersionId,
          version: {
            versionId: project.currentVersionId,
            versionNumber: project.currentVersionNumber,
          },
          files: allFiles.map((f) => ({
            path: f.path,
            size: f.sizeBytes,
            hash: f.sha256,
            mimeType: f.mimeType,
            isText: f.isText,
          })),
          assetNames: assetNames.assetNames,
          namingLanguage: assetNames.namingLanguage,
          ...(fileContent ? { file: fileContent } : {}),
          ...(exportJob ? { exportJob } : {}),
          ...(inlineWork ? { inlineWork } : {}),
        };
      },

      async createProject(auth, args) {
        const projectType = String(args.projectType ?? 'natural_language') as
          | 'natural_language'
          | 'template'
          | 'reference_video';
        const requestId = String(args.requestId ?? '');
        const title = typeof args.title === 'string' ? args.title : undefined;
        const templateId = typeof args.templateId === 'string' ? args.templateId : undefined;
        const requirements = typeof args.requirements === 'string' ? args.requirements : undefined;
        const namingLanguage = typeof args.namingLanguage === 'string' ? args.namingLanguage : undefined;
        const sessionId = typeof args.sessionId === 'string' && isUuid(args.sessionId) ? args.sessionId : undefined;

        const result = await createOrCloneProject(
          { workspace: deps.workspace, catalog: deps.catalog },
          auth,
          {
            title,
            templateId,
            projectType,
            requirements,
            namingLanguage,
            sessionId,
            requestId,
            sourceMeta:
              args.referenceVideoId || args.referenceUrl
                ? {
                    ...(args.referenceVideoId ? { referenceVideoId: args.referenceVideoId } : {}),
                    ...(args.referenceUrl ? { referenceUrl: args.referenceUrl } : {}),
                  }
                : null,
          },
        );

        return {
          projectId: result.projectId,
          sessionId: result.sessionId,
          title: result.title,
          ...(result.templateId ? { templateId: result.templateId } : {}),
          revision: result.revision,
          version: {
            versionId: result.versionId,
            versionNumber: result.versionNumber,
          },
          replayed: result.replayed,
          ...buildProjectPreviewHandoff(deps.config.APP_PUBLIC_ORIGIN, {
            id: result.projectId,
            sessionId: result.sessionId,
            revision: result.revision,
            currentVersionId: result.versionId,
          }),
        };
      },

      async editProject(auth, args) {
        const projectId = String(args.projectId ?? '');
        const requestId = String(args.requestId ?? '');
        const expectedRevision = String(args.expectedRevision ?? '');
        const expectedVersionId = String(args.expectedVersionId ?? '');
        const ops: ProjectFileOp[] = [];

        if (Array.isArray(args.files)) {
          for (const item of args.files) {
            if (item && typeof item === 'object') {
              const rec = item as { path: string; content: string };
              ops.push({
                op: 'upsert_text',
                path: rec.path,
                content: rec.content,
                stampHfIds: rec.path.endsWith('.html'),
              });
            }
          }
        }

        if (args.canvas && typeof args.canvas === 'object') {
          const canvas = args.canvas as { compositionPath: string; ratio: CanvasRatio; fit: CanvasFit };
          const existing = await deps.files.readTextFile(auth, projectId, canvas.compositionPath);
          if (!existing) {
            throw new CloudError('NOT_FOUND', `Composition '${canvas.compositionPath}' not found`, {
              status: 404,
              applied: false,
            });
          }
          const captionOps = await getCaptionOps();
          const reframed = compositionCanvasSource(
            existing.content,
            {
              parseHTML: captionOps.parseHTML,
              rewriteStyles: (source, aliases) => {
                let next = source;
                for (const [from, to] of aliases) {
                  next = next.replaceAll(`[${from}]`, `[${to}]`).replaceAll(`[${from}=`, `[${to}=`);
                }
                return next;
              },
            },
            { ratio: canvas.ratio, fit: canvas.fit },
          );
          ops.push({
            op: 'upsert_text',
            path: canvas.compositionPath,
            content: reframed.content,
            stampHfIds: true,
          });
        }

        let committed = null;
        if (ops.length > 0 || args.requirements !== undefined || args.namingLanguage !== undefined) {
          committed = await deps.files.commitChanges(auth, {
            projectId,
            ops,
            expectedRevision,
            expectedVersionId,
            requestId,
            idempotencyScope: 'phase1:motion_edit_project',
            source: 'agent',
            summary: typeof args.summary === 'string' ? args.summary : 'Agent project edit',
            actorKind: 'agent',
            projectUpdates: {
              ...(typeof args.requirements === 'string' ? { requirements: args.requirements } : {}),
              ...(typeof args.namingLanguage === 'string' ? { namingLanguage: args.namingLanguage } : {}),
            },
          });
        } else if (expectedRevision !== undefined || expectedVersionId !== undefined) {
          // Enforce optimistic concurrency even on metadata-only (`assetNames`) or no-op edits.
          const current = await deps.workspace.getProject(auth, projectId);
          if (expectedRevision !== undefined && current.revision !== expectedRevision) {
            throw new CloudError(
              'VERSION_CONFLICT',
              `Revision conflict: expected ${expectedRevision}, current is ${current.revision}.`,
              {
                status: 409,
                applied: false,
                details: {
                  expectedRevision,
                  currentRevision: current.revision,
                  currentVersionId: current.currentVersionId,
                },
              },
            );
          }
          if (expectedVersionId !== undefined && current.currentVersionId !== expectedVersionId) {
            throw new CloudError(
              'VERSION_CONFLICT',
              `Version conflict: expected ${expectedVersionId}, current is ${current.currentVersionId ?? 'none'}.`,
              {
                status: 409,
                applied: false,
                details: {
                  expectedVersionId,
                  currentVersionId: current.currentVersionId,
                  currentRevision: current.revision,
                },
              },
            );
          }
        }

        let assetNamesResult: { revision: string; versionId: string | null } | null = null;
        if (Array.isArray(args.assetNames) && args.assetNames.length > 0) {
          assetNamesResult = await deps.assetNames.updateAssetNames(auth, projectId, {
            assetNames: args.assetNames as Array<{ path: string; name: string }>,
            namingLanguage: typeof args.namingLanguage === 'string' ? args.namingLanguage : undefined,
            expectedRevision: committed ? committed.revision : expectedRevision,
            requestId: `${requestId}:asset-names`,
          });
        }

        const project = await deps.workspace.getProject(auth, projectId);
        return {
          projectId: project.id,
          sessionId: project.sessionId,
          revision: assetNamesResult?.revision ?? committed?.revision ?? project.revision,
          version: {
            versionId: assetNamesResult?.versionId ?? committed?.versionId ?? project.currentVersionId,
            versionNumber: project.currentVersionNumber,
          },
          changedFiles: committed?.changedPaths ?? (assetNamesResult ? ['motion-assets.json'] : []),
          replayed: committed?.replayed ?? false,
          ...buildProjectPreviewHandoff(deps.config.APP_PUBLIC_ORIGIN, project, {
            presentation: typeof args.presentation === 'string' ? args.presentation : undefined,
          }),
        };
      },

      async openPreview(auth, args) {
        const origin = deps.config.APP_PUBLIC_ORIGIN.replace(/\/$/, '');
        if (args.target === 'templates') {
          return templateLibraryPreview(origin, {
            embedded: typeof args.embedded === 'boolean' ? args.embedded : undefined,
            presentation: typeof args.presentation === 'string' ? args.presentation : undefined,
          });
        }
        if (args.target === 'providers') {
          return providerSettingsPreview(origin, {
            embedded: typeof args.embedded === 'boolean' ? args.embedded : undefined,
            presentation: typeof args.presentation === 'string' ? args.presentation : undefined,
            entry: typeof args.entry === 'string' ? args.entry : undefined,
          });
        }

        const action = typeof args.action === 'string' ? args.action : 'open';
        const projectId = typeof args.projectId === 'string' ? args.projectId : '';
        if (!projectId) {
          const catalog = await deps.workspace.getCatalog(auth);
          if (!catalog.activeId) {
            throw new CloudError('PROJECT_NOT_FOUND', 'No active project in workspace; specify projectId', {
              status: 404,
              applied: false,
            });
          }
          const active = await deps.workspace.getProject(auth, catalog.activeId);
          return {
            projectId: active.id,
            sessionId: active.sessionId,
            revision: active.revision,
            versionId: active.currentVersionId,
            ...buildProjectPreviewHandoff(origin, active, {
              embedded: typeof args.embedded === 'boolean' ? args.embedded : undefined,
              presentation: typeof args.presentation === 'string' ? args.presentation : undefined,
            }),
          };
        }

        if (action === 'begin') {
          const round = await deps.workRounds.create(auth, {
            projectId,
            mode: args.mode === 'create' ? 'create' : 'modify',
          });
          return { projectId, workId: round.id, workRound: round };
        }
        if (action === 'complete_generation') {
          const workId = String(args.workId ?? '');
          const round = await deps.workRounds.markSaved(auth, projectId, workId, {
            versionId: typeof args.expectedVersionId === 'string' ? args.expectedVersionId : undefined,
            revision: typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined,
          });
          return { projectId, workId: round.id, workRound: round };
        }
        if (action === 'record_display') {
          const display = (args.display ?? {}) as Record<string, unknown>;
          return (await deps.workspace.recordPreviewDisplay(auth, projectId, display)) as unknown as Record<string, unknown>;
        }
        if (action === 'record_review') {
          const review = (args.review ?? {}) as Record<string, unknown>;
          return (await deps.workspace.recordReview(auth, projectId, review)) as unknown as Record<string, unknown>;
        }

        const selected = await deps.workspace.selectProject(auth, projectId);
        return {
          projectId: selected.id,
          sessionId: selected.sessionId,
          revision: selected.revision,
          versionId: selected.currentVersionId,
          ...buildProjectPreviewHandoff(origin, selected, {
            embedded: typeof args.embedded === 'boolean' ? args.embedded : undefined,
            presentation: typeof args.presentation === 'string' ? args.presentation : undefined,
          }),
        };
      },

      async manageProject(auth, args) {
        const action = String(args.action ?? '');
        const projectId = String(args.projectId ?? '');
        if (action === 'duplicate') {
          const dup = await deps.archives.duplicateProject(auth, projectId, {
            title: typeof args.title === 'string' ? args.title : undefined,
            requestId: typeof args.requestId === 'string' ? args.requestId : undefined,
          });
          return dup as unknown as Record<string, unknown>;
        }
        if (action === 'info') {
          const project = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
          return {
            projectId: project.id,
            title: project.title,
            trashed: project.trashed,
            revision: project.revision,
            location: { available: false, reason: 'cloud' },
            project,
          };
        }
        const res = await deps.workspace.manageProject(auth, {
          action: action as 'rename' | 'trash' | 'restore' | 'delete' | 'reveal' | 'comments',
          projectId,
          title: typeof args.title === 'string' ? args.title : undefined,
          expectedTitle: typeof args.expectedTitle === 'string' ? args.expectedTitle : undefined,
          requestId: typeof args.requestId === 'string' ? args.requestId : undefined,
        });
        return res as unknown as Record<string, unknown>;
      },
    },

    versions: {
      async listVersions(auth, args) {
        const projectId = String(args.projectId ?? '');
        const cursorRaw = typeof args.cursor === 'string' ? Number.parseInt(args.cursor, 10) : undefined;
        const page = await deps.history.listVersions(auth, projectId, {
          limit: 5,
          cursorVersionNumber: cursorRaw && Number.isSafeInteger(cursorRaw) ? cursorRaw : undefined,
        });
        return page as unknown as Record<string, unknown>;
      },

      async restoreVersion(auth, args) {
        const projectId = String(args.projectId ?? '');
        const restored = await deps.history.restoreVersion(auth, projectId, {
          targetVersionId: String(args.versionId ?? ''),
          expectedRevision: String(args.expectedRevision ?? ''),
          expectedVersionId: String(args.expectedVersionId ?? ''),
          requestId: String(args.requestId ?? ''),
          actorKind: 'agent',
        });
        const project = await deps.workspace.getProject(auth, projectId);
        return {
          ...restored,
          version: {
            versionId: restored.versionId,
            versionNumber: restored.versionNumber,
          },
          ...buildProjectPreviewHandoff(deps.config.APP_PUBLIC_ORIGIN, project, {
            presentation: typeof args.presentation === 'string' ? args.presentation : undefined,
          }),
        };
      },
    },

    exports: {
      async exportRequest(auth, args) {
        const projectId = String(args.projectId ?? '');
        if (args.action === 'record_review') {
          const review = (args.review ?? {}) as Record<string, unknown>;
          return (await deps.workspace.recordReview(auth, projectId, review)) as unknown as Record<string, unknown>;
        }
        const started = await deps.exports.startExport(auth, projectId, {
          expectedRevision: typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined,
          expectedVersionId: typeof args.versionId === 'string' ? args.versionId : undefined,
          requestId: String(args.requestId ?? ''),
          compositionPath: typeof args.compositionPath === 'string' ? args.compositionPath : undefined,
          workId: typeof args.workId === 'string' ? args.workId : undefined,
          phase1: true,
        });
        return started as unknown as Record<string, unknown>;
      },

      async exportCancel(auth, args) {
        const job = await deps.exports.cancelExport(auth, String(args.jobId ?? ''));
        return { projectId: args.projectId, job };
      },
    },

    catalog: {
      async listTemplates(_auth, _args) {
        return { source: 'cloud-catalog-cas', ...await deps.catalog.listAllTemplates() };
      },

      async getTemplate(_auth, args) {
        const detail = await deps.catalog.getTemplate(String(args.templateId ?? ''));
        return detail as unknown as Record<string, unknown>;
      },

      async listSkills(_auth, _args) {
        const skills = await loadLibrarySkills(deps.runtimeRoot, false);
        const skillVersion = createHash('sha256')
          .update(JSON.stringify(skills.map((s) => ({ id: s.id, files: s.files }))))
          .digest('hex')
          .slice(0, 16);
        return {
          source: 'library-skills',
          skillVersion,
          total: skills.length,
          skills: skills.map(({ instructions: _inst, ...summary }) => summary),
        };
      },

      async getSkill(_auth, args) {
        const skillId = String(args.skillId ?? '');
        const skills = await loadLibrarySkills(deps.runtimeRoot, false);
        const found = skills.find((s) => s.id === skillId);
        if (!found) {
          throw new CloudError('NOT_FOUND', `Library skill '${skillId}' not found`, {
            status: 404,
            applied: false,
          });
        }
        return {
          ...found,
          nextStep: skillNextStep,
          motionDocument: { path: 'SKILL.md', content: found.instructions },
        };
      },
    },

    assets: {
      async handleAssetsUse(auth, args) {
        const action = String(args.action ?? '');

        if (action === 'transcript') {
          const transcript = (args.transcript ?? {}) as Record<string, unknown>;
          const command = String(transcript.command ?? '');
          const projectId = String(transcript.projectId ?? args.projectId ?? '');
          const compositionPath = String(transcript.compositionPath ?? 'index.html');
          if (!projectId) {
            throw new CloudError('INVALID_ARGUMENT', 'projectId is required for transcript operations', {
              status: 400,
              applied: false,
            });
          }
          const captionOps = await getCaptionOps();
          if (command === 'caption_add' || command === 'caption_update' || command === 'caption_toggle') {
            return commitCaptionCommand(deps.files, auth, captionOps, projectId, compositionPath, command, transcript);
          }
          const current = await deps.files.readTextFile(auth, projectId, compositionPath);
          if (!current) {
            throw new CloudError('NOT_FOUND', `Composition '${compositionPath}' not found`, {
              status: 404,
              applied: false,
            });
          }
          if (command === 'caption_tracks') {
            return { projectId, compositionPath, tracks: captionOps.captionTracks(current.content) };
          }
          if (command === 'caption_export') {
            const format = transcript.format === 'vtt' ? 'vtt' : 'srt';
            const trackId = typeof transcript.transcriptId === 'string' ? transcript.transcriptId : undefined;
            const exported = captionOps.exportCaptionSource(current.content, format, trackId);
            return { projectId, compositionPath, format, ...exported };
          }
          throw featureDeferredP2(`transcript.${command || 'unknown'}`);
        }

        if (action === 'list') {
          const list = await deps.assets.listAssets(auth, {
            modality: typeof args.modality === 'string' ? (args.modality as 'image' | 'video' | 'audio') : undefined,
            source: typeof args.source === 'string' ? (args.source as 'upload' | 'generated') : undefined,
            query: typeof args.query === 'string' ? args.query : undefined,
            sort:
              args.sort === 'newest' || args.sort === 'oldest' || args.sort === 'name'
                ? args.sort
                : undefined,
            trash: args.trash === true,
            offset: typeof args.offset === 'number' ? args.offset : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          return list as unknown as Record<string, unknown>;
        }

        if (action === 'get') {
          const detail = await deps.assets.getAsset(
            auth,
            String(args.assetId ?? ''),
            typeof args.versionId === 'string' ? args.versionId : undefined,
          );
          return detail as unknown as Record<string, unknown>;
        }

        if (action === 'update') {
          const changes =
            args.changes && typeof args.changes === 'object' && !Array.isArray(args.changes)
              ? (args.changes as { name?: string; trashed?: boolean; currentVersionId?: string })
              : {};
          const asset = await deps.assets.updateAsset(auth, String(args.assetId ?? ''), {
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.trashed !== undefined ? { trashed: changes.trashed } : {}),
            ...(changes.currentVersionId !== undefined ? { currentVersionId: changes.currentVersionId } : {}),
          });
          return { asset };
        }

        if (action === 'import_to_project') {
          const projectId = String(args.projectId ?? '');
          const requestId = String(args.requestId ?? randomUUID());
          const assetId = String(args.assetId ?? '');
          const versionId = String(args.versionId ?? '');
          const imported = await deps.importAssets.importItems(auth, {
            projectId,
            requestId,
            items: [
              {
                itemId: assetId,
                source: { kind: 'library_asset', assetId, versionId },
                ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name.trim() } : {}),
              },
            ],
          });
          const item = imported.items[0];
          if (item?.status === 'failed') {
            throw new CloudError(
              (item.error?.code as never) || 'IMPORT_FAILED',
              item.error?.message || 'Failed to import asset into project',
              { status: 400, applied: false },
            );
          }
          return {
            projectId: imported.projectId,
            revision: imported.revision,
            versionId: imported.versionId,
            item,
            ...(item?.path ? { path: item.path } : {}),
            replayed: imported.replayed ?? false,
          };
        }

        if (action === 'rename') {
          const asset = await deps.assets.updateAsset(auth, String(args.assetId ?? ''), {
            name: String(args.name ?? ''),
          });
          return { asset };
        }

        if (action === 'trash' || action === 'restore') {
          const asset = await deps.assets.updateAsset(auth, String(args.assetId ?? ''), {
            trashed: action === 'trash',
          });
          return { asset };
        }

        if (action === 'delete') {
          const res = await deps.assets.deleteAsset(auth, String(args.assetId ?? ''), { permanent: true });
          return res as unknown as Record<string, unknown>;
        }

        if (action === 'delete_version') {
          const res = await deps.assets.deleteAssetVersion(
            auth,
            String(args.assetId ?? ''),
            String(args.versionId ?? ''),
          );
          return res as unknown as Record<string, unknown>;
        }

        if (['generate', 'jobs', 'status', 'cancel', 'resume', 'retry_save'].includes(action)) {
          return deps.mediaJobs.handleMediaAction(auth, args);
        }

        if (action === 'read') {
          const assetId = String(args.assetId ?? '');
          const versionId = String(args.versionId ?? '');
          const presigned = await deps.assets.presignAssetVersionGet(
            auth,
            { assetId, versionId },
            { allowTrash: true },
          );
          return {
            assetId,
            versionId,
            mimeType: presigned.metadata.mimeType,
            bytes: presigned.metadata.sizeBytes,
            sha256: presigned.metadata.sha256,
            url: presigned.url,
            metadata: presigned.metadata.metadata,
          };
        }

        throw new CloudError('INVALID_ARGUMENT', `Unsupported asset action '${action}'`, {
          status: 400,
          applied: false,
        });
      },
    },

    archive: {
      async handleProjectArchive(auth, args) {
        const action = String(args.action ?? '');
        const requestId = String(args.requestId ?? randomUUID());
        if (action === 'export') {
          const res = await deps.archives.exportProjects(auth, {
            requestId,
            projectIds: Array.isArray(args.projectIds) ? (args.projectIds as string[]) : undefined,
            all: args.all === true,
            expectedRevisions:
              args.expectedRevisions && typeof args.expectedRevisions === 'object'
                ? (args.expectedRevisions as Record<string, string>)
                : undefined,
          });
          return res as unknown as Record<string, unknown>;
        }
        throw new CloudError(
          'INVALID_ARGUMENT',
          'LOCAL_PATH_UNSUPPORTED_IN_CLOUD: Upload project archives via POST /motion-api/project-archives/import in cloud deployments.',
          { status: 400, applied: false, details: { legacyCode: 'LOCAL_PATH_UNSUPPORTED_IN_CLOUD' } },
        );
      },
    },

    mediaJobs: deps.mediaJobs,
    importAssets: deps.importAssets,
    gateway: deps.gateway,
    async getWorkspaceDefaultModels(workspaceId) {
      const ws = await deps.authStore.findWorkspaceById(workspaceId);
      return (ws?.defaultModels ?? {}) as Record<string, string | undefined>;
    },
  };
}

// ---------------------------------------------------------------------------
// Main Stateless Hono `api` App Factory (Testable Without Opening Sockets)
// ---------------------------------------------------------------------------

export function createApiApp(deps: CreateApiAppDeps): { app: Hono<AuthEnv>; services: ApiAppServices } {
  const { config, db, storage, queues, eventBus } = deps;
  const logger = deps.logger ?? createLogger({ level: config.LOG_LEVEL, bindings: { service: 'api', role: 'api' } });
  const runtimeRoot = deps.runtimeRoot ?? DEFAULT_RUNTIME_ROOT;
  const authStore = deps.authStore ?? createPgAuthStore(db);
  const authCache = deps.authCache ?? new InMemoryAuthCache();
  const oidc =
    deps.oidc ??
    (config.AUTH_MODE === 'oidc' ? new OidcService(oidcConfigFromAppConfig(config), authCache) : undefined);
  const oauth21 = buildOAuth21Config(config);
  const gateway =
    deps.gateway ??
    createPlatformModelGateway(config, {
      opendesign: { cache: authCache },
    });

  const catalog = new CatalogService({
    db,
    storage,
    textCache: deps.hotTextCache instanceof HotTextCache ? deps.hotTextCache : undefined,
    logger,
    presignGetTtlSec: config.S3_PRESIGN_GET_TTL_SEC,
  });
  const welcomeBootstrap = deps.welcomeBootstrap ?? new WelcomeBootstrapService({ db, catalog, logger });

  const files = new ProjectFilesService({
    db,
    storage,
    hotTextCache: deps.hotTextCache,
    eventBus,
    historyCoalesceWindowMs: config.HISTORY_COALESCE_WINDOW_MS,
  });
  const history = new VersionHistoryService({
    db,
    storage,
    hotTextCache: deps.hotTextCache,
    eventBus,
    historyCoalesceWindowMs: config.HISTORY_COALESCE_WINDOW_MS,
  });
  const workspace = new WorkspaceService({
    onCatalogChange: workspaceId => {
      void eventBus.publish(workspaceCatalogChannel(workspaceId), { type: 'catalog-changed' }).catch(() => {});
    },
    db,
    storage,
    files,
    hotTextCache: deps.hotTextCache,
  });
  const assetNames = new AssetNamesService({ db, files });
  const workRounds = new WorkRoundsService(db);
  const archives = new ProjectArchiveService({ db, storage, workspace, files });
  const assets = new AssetLibraryService({
    db,
    storage,
    queues,
    eventBus,
    presignPutTtlSec: config.S3_PRESIGN_PUT_TTL_SEC,
    presignGetTtlSec: config.S3_PRESIGN_GET_TTL_SEC,
  });
  const exportsService = new ExportService({
    db,
    storage,
    queues,
    eventBus,
    presignGetTtlSec: config.S3_PRESIGN_GET_TTL_SEC,
  });
  const importAssets = new CloudImportAssetsService({
    store: createPgImportAssetsStore(db),
    storage,
    queues,
    eventBus,
    config,
  });
  const mediaJobs = createCloudMediaJobsPort({ db, queues, eventBus, assets });

  const mcpDispatcher = new McpToolDispatcher(
    config,
    createMcpDomainPorts({
      config,
      runtimeRoot,
      authStore,
      workspace,
      files,
      history,
      catalog,
      assets,
      exports: exportsService,
      workRounds,
      assetNames,
      archives,
      importAssets,
      gateway,
      mediaJobs,
    }),
  );

  const services: ApiAppServices = {
    authStore,
    gateway,
    catalog,
    welcomeBootstrap,
    files,
    history,
    workspace,
    assetNames,
    workRounds,
    archives,
    assets,
    exports: exportsService,
    importAssets,
    mediaJobs,
    mcpDispatcher,
  };

  const amrIdentity =
    deps.amrIdentity ??
    (config.AUTH_MODE === 'oidc' ? amrIdentityClientFromAppConfig(config, authCache) : undefined);

  const authDeps: AuthMiddlewareDeps = {
    config,
    store: authStore,
    cache: authCache,
    oidc,
    oauth21,
    amrIdentity,
    requireBearerOnDevMcp: deps.requireBearerOnDevMcp,
  };
  const authMiddleware = createAuthMiddleware(authDeps);

  // Bounded per-process cache of workspaces confirmed welcome-bootstrapped in PG.
  const bootstrappedWorkspaces = new Set<string>();
  const ensureWelcomeOnce = async (auth: AuthContext): Promise<void> => {
    if (deps.disableWelcomeBootstrap) return;
    if (bootstrappedWorkspaces.has(auth.workspaceId)) return;
    try {
      await welcomeBootstrap.ensureWelcomeProject(auth);
      if (bootstrappedWorkspaces.size >= WELCOME_CACHE_LIMIT) {
        bootstrappedWorkspaces.clear();
      }
      bootstrappedWorkspaces.add(auth.workspaceId);
    } catch (error) {
      if (
        isCloudError(error) &&
        (error.code === 'NOT_FOUND' ||
          error.code === 'TEMPLATE_NOT_COPYABLE' ||
          error.code === 'TEMPLATE_MEDIA_UNAVAILABLE')
      ) {
        logger.warn('Welcome template not yet synced in catalog; skipping first-access bootstrap', {
          workspaceId: auth.workspaceId,
          code: error.code,
        });
        return;
      }
      logger.warn('First-access welcome bootstrap failed (non-fatal)', {
        workspaceId: auth.workspaceId,
        error,
      });
    }
  };

  const appOriginUrl = new URL(config.APP_PUBLIC_ORIGIN);
  const previewOriginUrl = config.PREVIEW_PUBLIC_ORIGIN ? new URL(config.PREVIEW_PUBLIC_ORIGIN) : null;
  const previewHostIsolationEnabled = Boolean(
    previewOriginUrl && previewOriginUrl.host.toLowerCase() !== appOriginUrl.host.toLowerCase(),
  );
  const corsAllowedOrigins = resolveApiCorsAllowedOrigins(config);
  const corsAllowedOriginSet = new Set(corsAllowedOrigins);
  const previewTokenSecret = resolvePreviewTokenSecret(config);
  const previewHostRequests = new WeakSet<Request>();

  const authWithWelcome = async (c: Context<AuthEnv>, next: () => Promise<void>) => {
    if (previewHostRequests.has(c.req.raw)) {
      await next();
      return;
    }
    let ranNext = false;
    const response = await authMiddleware(c, async () => {
      const auth = c.get('auth');
      if (auth) {
        await ensureWelcomeOnce(auth);
      }
      ranNext = true;
      await next();
    });
    if (!ranNext && response) return response;
  };

  const fontsAuthMiddleware = async (c: Context<AuthEnv>, next: () => Promise<void>) => {
    if (previewHostRequests.has(c.req.raw)) {
      await next();
      return;
    }
    return authMiddleware(c, next);
  };

  const app = new Hono<AuthEnv>();

  app.onError((error, c) => {
    const auth = c.get('auth') as AuthContext | undefined;
    if (isCloudError(error)) {
      return c.json(error.toJSON(), error.status as ContentfulStatusCode);
    }
    logger.error('Unhandled API error', {
      error,
      method: c.req.method,
      path: c.req.path,
      ...(auth ? { userId: auth.userId, workspaceId: auth.workspaceId, authMethod: auth.authMethod } : {}),
      ...(auth?.clientId ? { clientId: auth.clientId } : {}),
    });
    return c.json({ code: 'INTERNAL_ERROR', error: 'Internal server error' }, 500);
  });

  // Structured audit/access log for API, Auth, OAuth & MCP traffic (spec §验收 2).
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const isAuditedRoute =
      path.startsWith('/motion-api/') ||
      path.startsWith('/api/') ||
      path === '/mcp' ||
      path.startsWith('/mcp/') ||
      path.startsWith('/auth/') ||
      path.startsWith('/oauth/');
    if (!isAuditedRoute || path.startsWith('/api/health')) {
      await next();
      return;
    }
    const startedAt = Date.now();
    await next();
    const auth = c.get('auth') as AuthContext | undefined;
    logger.info('HTTP request completed', {
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
      ...(auth
        ? {
            userId: auth.userId,
            workspaceId: auth.workspaceId,
            authMethod: auth.authMethod,
            ...(auth.entry ? { entry: auth.entry } : {}),
            ...(auth.clientId ? { clientId: auth.clientId } : {}),
          }
        : {}),
    });
  });

  // -------------------------------------------------------------------------
  // 0. Cookie-less Preview Subdomain Isolation Middleware (c5)
  //    Active whenever PREVIEW_PUBLIC_ORIGIN is configured on a distinct host.
  //    Never reads or sets session cookies; blocks all API/Auth/MCP/mutating routes.
  // -------------------------------------------------------------------------
  app.use('*', async (c, next) => {
    if (!previewHostIsolationEnabled || !previewOriginUrl) {
      await next();
      return;
    }

    const incomingHost = resolveIncomingRequestHost(c.req.raw, config.TRUST_PROXY_HOPS);
    if (normalizeHostForOrigin(incomingHost, previewOriginUrl) !== previewOriginUrl.host.toLowerCase()) {
      await next();
      return;
    }

    const requestOrigin = c.req.header('origin')?.trim() || null;
    const method = c.req.method.toUpperCase();
    const pathname = new URL(c.req.url).pathname;

    const rejectIsolated = (message: string) =>
      applyIsolatedPreviewHeaders(
        c.json({ code: 'PREVIEW_ORIGIN_ISOLATED', error: message, applied: false }, 403),
        appOriginUrl.origin,
        corsAllowedOriginSet,
        requestOrigin,
      );

    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      return rejectIsolated(`Method ${method} is blocked on the isolated preview origin.`);
    }

    const isPublicPreviewAsset =
      pathname === '/api/health/live' ||
      pathname === '/api/runtime.js' ||
      pathname.startsWith('/api/vendor/gsap/');
    const isReadOnlyFontAsset = pathname === '/api/fonts' || pathname.startsWith('/api/fonts/');
    const projectPreviewMatch = PREVIEW_PROJECT_PATH_RE.exec(pathname);

    if (!isPublicPreviewAsset && !isReadOnlyFontAsset && !projectPreviewMatch) {
      return rejectIsolated(`Route ${pathname} is blocked on the isolated preview origin.`);
    }

    if (method === 'OPTIONS') {
      return applyIsolatedPreviewHeaders(
        new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'X-OpenMotion-Preview-Token, Range, If-None-Match',
            'Access-Control-Max-Age': '600',
          },
        }),
        appOriginUrl.origin,
        corsAllowedOriginSet,
        requestOrigin,
      );
    }

    if (projectPreviewMatch) {
      let projectId: string;
      try {
        projectId = decodeURIComponent(projectPreviewMatch[1]);
      } catch {
        return applyIsolatedPreviewHeaders(
          c.json({ code: 'INVALID_PATH', error: 'Malformed projectId in preview path.', applied: false }, 400),
          appOriginUrl.origin,
          corsAllowedOriginSet,
          requestOrigin,
        );
      }

      const pathCredential = /^\/api\/projects\/[^/]+\/preview\/~assets\/([^/]+)\//.exec(pathname)?.[1];
      const credential = pathCredential ?? extractPreviewToken(c.req.raw);
      const signed = verifyPreviewToken(credential, previewTokenSecret, { expectedProjectId: projectId });
      const workspaceId = isAssetLease(pathCredential)
        ? await resolveAssetWorkspace(authCache, projectId, pathCredential)
        : signed?.wid;
      if (!workspaceId || !credential) {
        return applyIsolatedPreviewHeaders(
          c.json(
            {
              code: 'UNAUTHORIZED',
              error: 'Valid project-scoped preview token is required on the isolated preview origin.',
              applied: false,
            },
            401,
          ),
          appOriginUrl.origin,
          corsAllowedOriginSet,
          requestOrigin,
        );
      }

      c.set('previewAssetBase', previewAssetBase(previewOriginUrl.origin, projectId, signed?.assetLease ?? credential));
      c.set('auth', buildPreviewAuthContext({ wid: workspaceId, pid: projectId }, config.AUTH_MODE));
      previewHostRequests.add(c.req.raw);
    } else if (isReadOnlyFontAsset) {
      // Baked container fonts & Google Font CSS proxy carry no tenant secrets; never read session cookies.
      c.set('auth', {
        workspaceId: PREVIEW_FONT_VIEWER_ID,
        userId: PREVIEW_FONT_VIEWER_ID,
        role: 'viewer',
        scopes: ['projects:read'],
        authMode: config.AUTH_MODE,
        authMethod: 'preview_token',
        displayName: 'Preview Font Reader',
      });
      previewHostRequests.add(c.req.raw);
    }

    await next();
    c.res = applyIsolatedPreviewHeaders(c.res, appOriginUrl.origin, corsAllowedOriginSet, requestOrigin);
  });

  // -------------------------------------------------------------------------
  // 1. Unauthenticated Health Probes (`/api/health/live`, `/api/health/ready`, `/api/health`)
  // -------------------------------------------------------------------------

  const checkReadiness = async () => {
    const errors: string[] = [];
    const checkPg = async (): Promise<boolean> => {
      try {
        if (deps.checkDbHealth) return await deps.checkDbHealth();
        await db.execute(sql`SELECT 1`);
        return true;
      } catch (error) {
        errors.push(`postgres: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    const checkRedis = async (): Promise<boolean> => {
      try {
        if (deps.checkRedisHealth) return await deps.checkRedisHealth();
        if (eventBus.checkHealth) return await eventBus.checkHealth();
        return true;
      } catch (error) {
        errors.push(`redis: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    const checkS3 = async (): Promise<boolean> => {
      try {
        if (deps.checkStorageHealth) return await deps.checkStorageHealth();
        if (storage instanceof StorageService) {
          await storage.internalClient.send(new HeadBucketCommand({ Bucket: storage.bucket }));
          return true;
        }
        await storage.headObject('catalog/blobs/' + '0'.repeat(64));
        return true;
      } catch (error) {
        errors.push(`storage: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };

    const [postgres, redis, s3] = await Promise.all([checkPg(), checkRedis(), checkS3()]);
    const ok = postgres && redis && s3;
    return {
      ok,
      status: ok ? 'ready' : 'not_ready',
      version: VERSION,
      checks: { postgres, redis, storage: s3 },
      ...(errors.length > 0 ? { errors } : {}),
    };
  };

  app.get('/api/health/live', (c) => {
    return c.json({ ok: true, status: 'live', service: 'api', version: VERSION, ts: Date.now() }, 200);
  });

  app.get('/api/health/ready', async (c) => {
    const report = await checkReadiness();
    return c.json(report, report.ok ? 200 : 503);
  });

  app.get('/api/health', async (c) => {
    const report = await checkReadiness();
    return c.json(
      {
        ...report,
        mcp: phase1McpCapabilities,
      },
      report.ok ? 200 : 503,
    );
  });

  app.get('/motion-api/health', async (c) => {
    const report = await checkReadiness();
    return c.json(
      {
        ...report,
        mcp: phase1McpCapabilities,
      },
      report.ok ? 200 : 503,
    );
  });

  // -------------------------------------------------------------------------
  // 2. Auth & OAuth 2.1 Routes (`/auth/*`, `/.well-known/*`, `/oauth/*`, `/motion-api/tokens*`)
  // -------------------------------------------------------------------------

  app.route('/', createAuthRoutes(authDeps));

  // -------------------------------------------------------------------------
  // 3. Streamable HTTP MCP (`/mcp` — Strict Bearer-Only Auth + 10 MiB Limit)
  // -------------------------------------------------------------------------

  const mcpSessionStore = deps.mcpSessionStore ?? new InMemoryMcpSessionStore();
  app.route(
    '/',
    createMcpHttpRoutes({
      config,
      auth: authDeps,
      dispatcher: mcpDispatcher,
      sessionStore: mcpSessionStore,
      eventBus,
      rateLimiter: deps.rateLimiter,
    }),
  );

  // -------------------------------------------------------------------------
  // 4. Static Design System, Studio Assets, MCP UI & Read-Only Vendor GSAP
  // -------------------------------------------------------------------------

  const allowSourcemaps = config.NODE_ENV !== 'production';
  const browserObservabilityConfig = buildBrowserObservabilityConfig({
    dsn: config.SENTRY_WEB_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: config.SENTRY_RELEASE ?? `openmotion@${VERSION}`,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    previewOrigin: previewHostIsolationEnabled && previewOriginUrl ? previewOriginUrl.origin : null,
    appVersion: VERSION,
    deploymentMode: 'cloud-container',
  });

  const handleStaticPath = async (c: Context) => {
    const response = await serveStaticAsset(
      new URL(c.req.url).pathname,
      runtimeRoot,
      c.req.method === 'HEAD',
      { allowSourcemaps },
    );
    if (response) return response;
    return c.notFound();
  };

  app.get('/design-system', handleStaticPath);
  app.get('/design-system/*', handleStaticPath);
  app.get('/web/design-system/*', handleStaticPath);
  app.get('/favicon.svg', handleStaticPath);
  app.get('/editor-assets/*', handleStaticPath);
  app.get('/guide-assets/*', handleStaticPath);
  app.get('/web/catalog/*', handleStaticPath);
  app.get('/web/inline-video.html', handleStaticPath);
  app.get('/web/inline-video.css', handleStaticPath);
  app.get('/web/inline-video.js', handleStaticPath);
  app.get('/web/inline-video-notices.txt', handleStaticPath);
  app.get('/web/final-video-component.js', handleStaticPath);
  app.get('/mcp-ui/template-recommendations/*', handleStaticPath);

  // -------------------------------------------------------------------------
  // 5. Template Catalog Routes (Mounted at BOTH `/api` and `/motion-api`)
  //    Read-only catalog discovery is public; clone/open require authenticated workspace.
  // -------------------------------------------------------------------------

  app.use('/api/templates/:id/clone', authWithWelcome);
  app.use('/api/templates/:id/open', authWithWelcome);
  app.use('/motion-api/templates/:id/clone', authWithWelcome);
  app.use('/motion-api/templates/:id/open', authWithWelcome);

  app.route('/api', createCatalogRoutes({ catalog, logger, basePath: '' }));
  app.route('/motion-api', createCatalogRoutes({ catalog, logger, basePath: '' }));

  // -------------------------------------------------------------------------
  // 6. Authenticated Cloud Integration, Runtime, Connect & Telemetry Endpoints
  // -------------------------------------------------------------------------

  const buildIntegrationPayload = (auth: AuthContext) =>
    buildCloudIntegrationInfo({
      publicOrigin: config.APP_PUBLIC_ORIGIN,
      version: VERSION,
      workspaceId: auth.workspaceId,
      authMode: config.AUTH_MODE,
      oauth2Enabled: true,
      patEnabled: true,
      authorizationServerUrl: oauth21.issuer,
      resourceMetadataUrl: oauth21.resourceMetadataUrl,
      tools: phase1Tools.map((tool) => ({ name: tool.name, description: tool.description })),
    });

  app.get('/motion-api/integration', authWithWelcome, (c) => {
    return c.json(buildIntegrationPayload(getAuthContext(c)));
  });
  app.get('/api/integration', authWithWelcome, (c) => {
    return c.json(buildIntegrationPayload(getAuthContext(c)));
  });

  app.get('/connect/config', authWithWelcome, (c) => {
    const info = buildIntegrationPayload(getAuthContext(c));
    const host = integrationHost(c.req.query('host') ?? null);
    const configFile = integrationConfig(info, host);
    return new Response(configFile.text, {
      status: 200,
      headers: {
        'Content-Type': configFile.contentType,
        'Content-Disposition': `attachment; filename="${configFile.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  app.get('/connect/guide', authWithWelcome, (c) => {
    const info = buildIntegrationPayload(getAuthContext(c));
    const host = integrationHost(c.req.query('host') ?? null);
    return new Response(agentGuide(info, host), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  });

  app.get('/motion-api/runtime', authMiddleware, (c) => {
    return c.json({
      ready: true,
      managed: false,
      mode: 'cloud-container',
      capabilities: { media: true, export: true },
    });
  });

  app.get('/motion-api/tracking', authMiddleware, (c) => {
    return c.json({ enabled: false, locked: true, reason: 'cloud' });
  });
  app.post('/motion-api/tracking', authMiddleware, (c) => {
    return c.json({ ok: true, accepted: false }, 202);
  });
  const trackingPreferencesPayload = {
    enabled: false,
    preference: false,
    locked: true,
    reason: 'environment' as const,
  };
  app.get('/motion-api/tracking/preferences', authMiddleware, (c) => {
    return c.json(trackingPreferencesPayload);
  });
  app.put('/motion-api/tracking/preferences', authMiddleware, (c) => {
    return c.json(trackingPreferencesPayload);
  });
  app.post('/motion-api/tracking/preferences', authMiddleware, (c) => {
    return c.json(trackingPreferencesPayload);
  });
  app.post('/motion-api/diagnostics', authMiddleware, (c) => {
    return c.json({ ok: true, mode: 'cloud-container', version: VERSION });
  });
  app.post('/motion-api/diagnostics/events', authMiddleware, (c) => {
    return c.json({ ok: true }, 202);
  });

  // POST /motion-api/phase1/call — Studio bridge delegating directly to the canonical MCP tool dispatcher.
  app.post('/motion-api/phase1/call', authWithWelcome, async (c) => {
    const auth = getAuthContext(c);
    let body: { name?: unknown; arguments?: unknown };
    try {
      const parsed = await c.req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Body must be a JSON object');
      }
      body = parsed as { name?: unknown; arguments?: unknown };
    } catch {
      throw new CloudError('INVALID_ARGUMENT', 'Request body must be a JSON object with name and optional arguments', {
        status: 400,
        applied: false,
      });
    }

    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new CloudError('INVALID_ARGUMENT', 'Tool name is required', { status: 400, applied: false });
    }

    const result = await mcpDispatcher.dispatch(body.name, body.arguments ?? {}, {
      auth,
      supportsMcpAppsUi: false,
    });

    const firstContent = result.content?.[0];
    const firstText = firstContent?.type === 'text' ? firstContent.text : undefined;

    if (result.isError) {
      const structuredError = (result.structuredContent as { error?: Record<string, unknown> } | undefined)?.error;
      const rawStatus = typeof structuredError?.status === 'number' ? structuredError.status : 400;
      const status = (rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 400) as ContentfulStatusCode;
      const code = typeof structuredError?.code === 'string' ? structuredError.code : 'TOOL_FAILED';
      const message =
        typeof structuredError?.message === 'string'
          ? structuredError.message
          : firstText || 'Tool execution failed';
      return c.json(
        {
          code,
          error: message,
          message,
          applied: structuredError?.applied ?? false,
          ...(structuredError?.details ? { details: structuredError.details } : {}),
        },
        status,
      );
    }

    if (result.structuredContent !== undefined) {
      return c.json(result.structuredContent, 200);
    }
    if (typeof firstText === 'string' && firstText.trim()) {
      try {
        return c.json(JSON.parse(firstText), 200);
      } catch {
        return c.json({ ok: true, text: firstText }, 200);
      }
    }
    return c.json({ ok: true }, 200);
  });

  // GET /motion-api/generations & POST /motion-api/generations/:id/cancel — Studio media generation polling/cancel aliases.
  app.get('/motion-api/generations', authWithWelcome, async (c) => {
    const auth = getAuthContext(c);
    if (!hasScope(auth, 'assets:read')) {
      throw new CloudError('INSUFFICIENT_SCOPE', 'Missing required scope: assets:read', {
        status: 403,
        applied: false,
      });
    }
    const projectId = c.req.query('projectId') || undefined;
    const limitRaw = c.req.query('limit');
    const offsetRaw = c.req.query('offset');
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
    const offset = offsetRaw !== undefined ? Number.parseInt(offsetRaw, 10) : undefined;
    const list = await mediaJobs.listJobs(auth, {
      projectId,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
      offset: offset !== undefined && Number.isFinite(offset) ? offset : undefined,
    });
    return c.json(list, 200);
  });

  app.post('/motion-api/generations/:id/cancel', authWithWelcome, async (c) => {
    const auth = getAuthContext(c);
    if (!hasScope(auth, 'media:generate')) {
      throw new CloudError('INSUFFICIENT_SCOPE', 'Missing required scope: media:generate', {
        status: 403,
        applied: false,
      });
    }
    if (!hasMinRole(auth, 'editor')) {
      throw new CloudError('FORBIDDEN', 'Workspace editor role or higher is required', {
        status: 403,
        applied: false,
      });
    }
    const jobId = c.req.param('id') ?? '';
    const result = await mediaJobs.cancelJob(auth, jobId);
    return c.json(result, 200);
  });

  // -------------------------------------------------------------------------
  // 7. Authenticated Product Routes (`/motion-api/*`)
  // -------------------------------------------------------------------------

  // Note: In Hono, `/prefix/*` matches both `/prefix` and `/prefix/...`, so register once per prefix.
  app.use('/motion-api/projects/*', authWithWelcome);
  app.use('/motion-api/project/*', authWithWelcome);
  app.use('/motion-api/preview/*', authWithWelcome);
  app.use('/motion-api/sessions/*', authWithWelcome);
  app.use('/motion-api/project-archives/*', authWithWelcome);
  app.use('/motion-api/assets/*', authWithWelcome);
  app.use('/motion-api/exports/*', authWithWelcome);
  app.use('/motion-api/render/*', authWithWelcome);
  app.use('/motion-api/models/*', authWithWelcome);
  app.use('/motion-api/account/*', authWithWelcome);

  app.route(
    '/',
    createProjectsRouter({
      workspace,
      files,
      history,
      assetNames,
      workRounds,
      archives,
      catalog,
      exports: exportsService,
      authStore,
    }),
  );
  app.route('/', createSessionsRouter({ workspace, catalog, exports: exportsService }));
  app.route('/', createArchivesRouter({ archives }));
  app.route('/motion-api/assets', createAssetRoutes({ assetService: assets }));
  app.route('/motion-api', createExportRoutes({ exportService: exportsService }));
  app.route('/motion-api/models', createModelRoutes({ gateway, authStore, mediaJobs }));
  app.route('/motion-api/account', createAccountRoutes({ config, authStore, gateway, cache: authCache }));

  // -------------------------------------------------------------------------
  // 8. Explicit P2 Deferred Routes (`501 FEATURE_DEFERRED_P2`)
  //    Static read-only Brand Kit catalog JSON/SVG remains accessible with zero disk writes.
  // -------------------------------------------------------------------------

  const sendDeferredP2 = (feature: string) => (c: Context) => {
    return c.json(featureDeferredP2(feature).toJSON(), 501);
  };

  app.all('/motion-api/design', authMiddleware, sendDeferredP2('design_studio'));
  app.all('/motion-api/design/*', authMiddleware, sendDeferredP2('design_studio'));

  app.get('/motion-api/brand-kits/catalog', async (c) => {
    try {
      const brandCatalog = await readBrandCatalog();
      return c.json(brandCatalog, 200);
    } catch {
      return c.json({ schemaVersion: 1, repository: '', revision: '', entries: [] }, 200);
    }
  });

  app.get('/motion-api/brand-kits/catalog/assets/gsap.min.js', async (c) => {
    const bytes = await readGsapFile(runtimeRoot, 'gsap.min.js');
    if (!bytes) return c.notFound();
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  app.get('/motion-api/brand-kits/catalog/:id/:asset', async (c) => {
    const id = c.req.param('id');
    const asset = c.req.param('asset');
    if (asset === 'import') {
      return c.json(featureDeferredP2('brand_kit_website_capture').toJSON(), 501);
    }
    try {
      const entry = await catalogEntry(id);
      if (asset === 'style-cover.svg' || asset === 'cover') {
        return new Response(catalogStyleCover(entry), {
          status: 200,
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'",
          },
        });
      }
      if (asset === 'poster.svg') {
        return new Response(catalogPoster(entry), {
          status: 200,
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'",
          },
        });
      }
      if (asset === 'showcase') {
        const nonce = randomUUID().replace(/-/g, '');
        return new Response(catalogShowcase(entry, c.req.query('detail') === '1', nonce), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`,
          },
        });
      }
      return c.notFound();
    } catch {
      return c.notFound();
    }
  });

  app.all('/motion-api/brand-kits', authMiddleware, sendDeferredP2('brand_kit_website_capture'));
  app.all('/motion-api/brand-kits/*', authMiddleware, sendDeferredP2('brand_kit_website_capture'));

  const handleTranscriptsRoute = sendDeferredP2('transcription');
  app.all('/motion-api/transcripts', authMiddleware, handleTranscriptsRoute);
  app.all('/motion-api/transcripts/*', authMiddleware, handleTranscriptsRoute);
  app.all('/motion-api/projects/:id/transcripts', authMiddleware, handleTranscriptsRoute);
  app.all('/motion-api/projects/:id/transcripts/*', authMiddleware, handleTranscriptsRoute);

  app.all('/motion-api/review-comments', authMiddleware, sendDeferredP2('review_comments'));
  app.all('/motion-api/review-comments/*', authMiddleware, sendDeferredP2('review_comments'));
  app.all('/motion-api/projects/:id/review-comments', authMiddleware, sendDeferredP2('review_comments'));
  app.all('/motion-api/projects/:id/review-comments/*', authMiddleware, sendDeferredP2('review_comments'));

  // -------------------------------------------------------------------------
  // 9. Diskless Studio Hono Router (`src/studio/index.ts`)
  //    Authenticated for tenant/project/render/font/event/env endpoints;
  //    `/api/runtime.js`, `/api/vendor/*`, `/__hyperframes_config` remain readable.
  // -------------------------------------------------------------------------

  app.use('/api/projects/*', authWithWelcome);
  if (previewHostIsolationEnabled && previewOriginUrl) {
    app.use('/api/projects/:id/*', async (c, next) => {
      if (previewHostRequests.has(c.req.raw) || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) {
        return next();
      }

      // HTML/SVG and historical blobs remain readable for the editor. If a
      // browser navigates to raw file content, it gets an inert, opaque document.
      c.header('Content-Security-Policy', "sandbox; script-src 'none'; form-action 'none'");
      c.header('X-Content-Type-Options', 'nosniff');
      const source = new URL(c.req.url);
      const isPreviewDocument = /^\/api\/projects\/[^/]+\/preview(?:\/?|\/comp\/.*)$/.test(source.pathname);
      if (!isPreviewDocument || c.req.header('sec-fetch-mode') !== 'navigate') return next();

      // A preview iframe on a sibling host must never mint a token by framing
      // the main host with the user's same-site session cookie.
      const site = c.req.header('sec-fetch-site');
      if (site !== 'same-origin' && site !== 'none') {
        return c.json({ error: 'Open this preview from Studio.' }, 403);
      }
      const auth = getAuthContext(c);
      if (!hasScope(auth, 'projects:read')) return c.json({ error: 'Project read access required.' }, 403);
      const projectId = c.req.param('id');
      await workspace.getProject(auth, projectId, { allowTrashed: true });
      const signed = signPreviewToken({
        workspaceId: auth.workspaceId, projectId, ttlSec: config.PREVIEW_TOKEN_TTL_SEC,
      }, previewTokenSecret);
      const target = new URL(source.pathname + source.search, previewOriginUrl.origin);
      target.searchParams.set(PREVIEW_TOKEN_QUERY_PARAM, signed.token);
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      return c.redirect(target.href, 302);
    });
  }
  app.use('/api/render/*', authWithWelcome);
  app.use('/api/media-jobs/*', authWithWelcome);
  app.use('/api/fonts/*', fontsAuthMiddleware);
  app.use('/api/events', authWithWelcome);
  app.use('/api/environment/ffmpeg', authMiddleware);
  app.use('/api/open-in-desktop', authMiddleware);
  app.use('/api/assets/global', authMiddleware);
  app.use('/api/registry/blocks', authMiddleware);

  // POST /api/projects/:id/preview-token — Mint short-lived project-scoped HS256 token on the main origin
  // so Studio / clients can open cookie-less isolated preview URLs on PREVIEW_PUBLIC_ORIGIN (c5).
  app.post('/api/projects/:id/preview-token', async (c) => {
    const auth = getAuthContext(c);
    if (!hasScope(auth, 'projects:read')) {
      throw new CloudError('INSUFFICIENT_SCOPE', 'Missing required scope: projects:read', {
        status: 403,
        applied: false,
      });
    }
    const projectId = c.req.param('id') ?? '';
    await workspace.getProject(auth, projectId, { allowTrashed: true });

    const body = await c.req.text();
    let requested: unknown;
    if (body) {
      try {
        requested = JSON.parse(body)?.assetLease;
      } catch {
        return c.json({ error: 'Invalid preview token request.' }, 400);
      }
    }
    let assetLease: string | undefined;
    if (requested === true || isAssetLease(requested)) {
      assetLease = await renewAssetLease(authCache, auth.workspaceId, projectId, requested, config.PREVIEW_TOKEN_TTL_SEC);
    } else if (requested !== undefined) {
      return c.json({ error: 'Invalid preview asset lease.' }, 400);
    }
    const signed = signPreviewToken(
      {
        workspaceId: auth.workspaceId,
        assetLease,
        projectId,
        ttlSec: config.PREVIEW_TOKEN_TTL_SEC,
      },
      previewTokenSecret,
    );
    const previewOrigin = previewOriginUrl ? previewOriginUrl.origin : null;
    const targetOrigin = previewOrigin ?? appOriginUrl.origin;
    const previewUrl = `${targetOrigin}/api/projects/${encodeURIComponent(projectId)}/preview?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(signed.token)}`;

    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        token: signed.token,
        expiresAt: signed.expiresAt,
        ...(assetLease && { assetLease }),
        previewOrigin,
        previewUrl,
      },
      200,
    );
  });

  const detectedFontsDir =
    deps.fontsDir ?? (existsSync('/app/fonts') ? '/app/fonts' : undefined);

  const studioDeps: DisklessStudioDeps & { readonly previewOrigin: string | null } = {
    db,
    storage,
    hotTextCache: deps.hotTextCache,
    eventBus,
    queues,
    workspace,
    files,
    history,
    assetNames,
    workRounds,
    fontsDir: detectedFontsDir,
    runtimeRoot,
    studioVersion: VERSION,
    previewOrigin: previewOriginUrl ? previewOriginUrl.origin : null,
  };
  const studioApp = createDisklessStudioApp(studioDeps);
  app.route('/', studioApp);

  // -------------------------------------------------------------------------
  // 10. Built Studio SPA Static Assets & `index.html` Fallback (Non-API Routes)
  // -------------------------------------------------------------------------

  const isReservedApiPrefix = (pathname: string): boolean =>
    pathname === '/mcp' ||
    pathname.startsWith('/api/') ||
    pathname === '/api' ||
    pathname.startsWith('/motion-api/') ||
    pathname === '/motion-api' ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/.well-known/') ||
    pathname === '/__hyperframes_config';

  app.get('*', async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (isReservedApiPrefix(pathname)) {
      return c.json({ code: 'NOT_FOUND', error: `Route not found: ${pathname}` }, 404);
    }

    const headOnly = c.req.method === 'HEAD';
    const studioBuildDir = path.join(runtimeRoot, 'studio/build');

    // Attempt exact static file under studio/build first (e.g. /assets/*, /manifest.json).
    if (pathname !== '/' && pathname !== '/index.html' && path.extname(pathname)) {
      if (!allowSourcemaps && pathname.toLowerCase().endsWith('.map')) {
        return c.notFound();
      }
      const resolved = resolveSafeSubpath(studioBuildDir, pathname);
      if (resolved) {
        const asset = await readStaticResponse(resolved, {
          cacheControl: 'public, max-age=3600',
          headOnly,
        });
        if (asset) return asset;
      }
      return c.notFound();
    }

    // SPA index.html fallback for client-side routes, with runtime observability config injected when enabled.
    try {
      const rawHtml = await readFile(path.join(studioBuildDir, 'index.html'), 'utf8');
      const renderedHtml = injectRuntimeConfigIntoHtml(rawHtml, browserObservabilityConfig);
      const previewOriginMeta = previewHostIsolationEnabled && previewOriginUrl
        ? `<meta name="openmotion-preview-origin" content="${previewOriginUrl.origin}">`
        : '';
      const studioHtml = renderedHtml.replace('</head>',
        `<meta name="openmotion-runtime" content="cloud-diskless" data-editor-open="1">${previewOriginMeta}</head>`);
      const bytes = Buffer.from(studioHtml, 'utf8');
      return new Response(headOnly ? null : bytes, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(bytes.byteLength),
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    return new Response('OpenMotion Studio has not been built yet. Run npm run build:studio.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  });

  return { app, services };
}

// ---------------------------------------------------------------------------
// Production / Dev Runtime Server Bootstrap & Graceful Shutdown
// ---------------------------------------------------------------------------

export interface StartApiServerOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  readonly installSignals?: boolean;
  readonly onShutdownComplete?: (clean: boolean) => void;
}

export async function startApiServer(options: StartApiServerOptions = {}): Promise<ApiServerHandle> {
  const config = options.config ?? getConfig();
  const logger =
    options.logger ??
    createLogger({ level: config.LOG_LEVEL, bindings: { service: 'api', role: config.WORKER_ROLE } });

  const shutdown = new ShutdownCoordinator({ logger, timeoutMs: 30_000 });

  const dbHandle: DbHandle = createDbHandle({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
  });
  shutdown.register('postgres', () => dbHandle.close());

  const storage = new StorageService({
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    defaultPresignPutTtlSec: config.S3_PRESIGN_PUT_TTL_SEC,
    defaultPresignGetTtlSec: config.S3_PRESIGN_GET_TTL_SEC,
    publicOrigin: config.APP_PUBLIC_ORIGIN,
  });
  shutdown.register('storage', () => {
    storage.close();
  });

  const redisCmd: Redis = createRedisClient(config.REDIS_URL, 'command');
  shutdown.register('redis-cmd', async () => {
    await redisCmd.quit();
  });

  const redisCache: Redis =
    config.REDIS_CACHE_URL && config.REDIS_CACHE_URL !== config.REDIS_URL
      ? createRedisClient(config.REDIS_CACHE_URL, 'command')
      : redisCmd;
  if (redisCache !== redisCmd) {
    shutdown.register('redis-cache', async () => {
      await redisCache.quit();
    });
  }

  const eventBus = new RedisEventBus(config.REDIS_URL);
  shutdown.register('redis-event-bus', () => eventBus.close());

  const queues = new QueueService(config.REDIS_URL);
  shutdown.register('bullmq-queues', () => queues.close());

  const hotTextCache = new HotTextCache(redisCache, config.REDIS_CACHE_TTL_SEC);
  const rateLimiter = new RateLimiter(redisCmd);
  const authStore = createPgAuthStore(dbHandle.db);
  const authCache = createRedisAuthCache(redisCmd);
  const mcpSessionStore = new RedisMcpSessionStore(redisCmd);

  const { app, services } = createApiApp({
    config,
    db: dbHandle.db,
    storage,
    queues,
    eventBus,
    hotTextCache,
    rateLimiter,
    authStore,
    authCache,
    mcpSessionStore,
    logger,
    checkDbHealth: () => dbHandle.checkHealth(),
    checkRedisHealth: async () => (await redisCmd.ping()) === 'PONG',
  });

  // In AUTH_MODE=dev, eagerly provision the dev tenant & welcome project (non-fatal if catalog isn't synced yet).
  if (config.AUTH_MODE === 'dev') {
    try {
      const provisionDev = createDevTenantProvisioner(authStore, config);
      const devAuth = await provisionDev();
      await services.welcomeBootstrap.ensureWelcomeProject(devAuth).catch((error) => {
        logger.warn('Startup dev welcome bootstrap skipped', { error });
      });
    } catch (error) {
      logger.warn('Startup dev tenant pre-provisioning skipped', { error });
    }
  }

  const server = await new Promise<ServerType>((resolve, reject) => {
    let resolved = false;
    const instance = serve(
      {
        fetch: app.fetch,
        hostname: config.BIND_HOST,
        port: config.PORT,
      },
      () => {
        resolved = true;
        resolve(instance);
      },
    );
    instance.once('error', (error) => {
      if (!resolved) reject(error);
    });
  });

  shutdown.register('http-server', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  // Periodic cleanup of anonymous DCR OAuth clients that never exchanged a token (spec §6.6).
  if (config.AUTH_MODE === 'oidc' && config.MCP_OAUTH_MODE === 'proxy') {
    const DCR_CLEANUP_INTERVAL_MS = 60 * 60_000;
    const DCR_UNUSED_MAX_AGE_MS = 24 * 60 * 60_000;
    const runCleanup = async () => {
      try {
        const deleted = await authStore.cleanupUnusedOAuthClients(new Date(Date.now() - DCR_UNUSED_MAX_AGE_MS));
        if (deleted > 0) {
          logger.info('Swept unused anonymous DCR OAuth clients', { deleted });
        }
      } catch (error) {
        logger.warn('Unused DCR OAuth client sweep failed', { error });
      }
    };
    const cleanupTimer = setInterval(() => {
      void runCleanup();
    }, DCR_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    shutdown.register('oauth-dcr-cleanup', () => {
      clearInterval(cleanupTimer);
    });
  }

  if (options.installSignals !== false) {
    shutdown.installSignalHandlers(options.onShutdownComplete);
  }

  const corsAllowedOrigins = resolveApiCorsAllowedOrigins(config);

  logger.info('OpenMotion cloud API server listening', {
    host: config.BIND_HOST,
    port: config.PORT,
    publicOrigin: config.APP_PUBLIC_ORIGIN,
    previewOrigin: config.PREVIEW_PUBLIC_ORIGIN ?? null,
    corsAllowedOrigins,
    historyCoalesceWindowMs: config.HISTORY_COALESCE_WINDOW_MS,
    s3PresignCacheWindowSec: config.S3_PRESIGN_CACHE_WINDOW_SEC,
    authMode: config.AUTH_MODE,
    modelGatewayMode: config.MODEL_GATEWAY_MODE,
    sentryWebEnabled: Boolean(config.SENTRY_WEB_DSN),
    version: VERSION,
    designSystemFiles: publicDesignFiles.length,
  });

  return {
    app,
    services,
    server,
    shutdown,
    port: config.PORT,
    host: config.BIND_HOST,
    close: (reason = 'manual') => shutdown.shutdown(reason),
  };
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectEntry()) {
  startApiServer({ installSignals: true }).catch((error) => {
    const logger = createLogger({ level: 'error', bindings: { service: 'api-entrypoint' } });
    logger.error('Fatal API server startup failure', { error });
    process.exit(1);
  });
}
