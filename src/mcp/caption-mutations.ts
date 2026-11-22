import { createHash, randomUUID } from 'node:crypto';
import type { loadCaptionSourceOperations } from '../../shared/transcript-captions.ts';
import type { TranscriptSegment } from '../../shared/transcript.ts';
import type { CaptionSettings } from '../../shared/caption-style.ts';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { ProjectFilesService } from '../services/project-files-service.ts';

type CaptionOps = Awaited<ReturnType<typeof loadCaptionSourceOperations>>;
type Command = 'caption_add' | 'caption_update' | 'caption_toggle';

function requestHash(request: Record<string, unknown>): string {
  // JSON object key order may change across MCP clients; cue array order is significant.
  const json = JSON.stringify(request, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
  return createHash('sha256').update(json).digest('hex');
}

function editCaptions(ops: CaptionOps, html: string, command: Command, args: Record<string, unknown>) {
  const trackId = typeof args.transcriptId === 'string' ? args.transcriptId : randomUUID();
  if (command === 'caption_toggle') return ops.toggleCaptionSource(html, trackId, Boolean(args.visible));
  if (command === 'caption_update') {
    return { ...ops.updateCaptionTrackSource(html, trackId, args.captionSettings ?? {}, args.remove === true), trackId };
  }
  const added = ops.manualCaptionSource(html, trackId, {
    segments: args.segments as TranscriptSegment[] | undefined,
    subtitles: args.subtitles as string | undefined,
    timelineStart: args.timelineStart as number | undefined,
    textKind: args.textKind === 'text' ? 'text' : 'caption',
    captionSettings: args.captionSettings as Partial<CaptionSettings> | undefined,
  });
  return { ...added, trackId };
}

export async function commitCaptionCommand(
  files: ProjectFilesService, auth: AuthContext, ops: CaptionOps, projectId: string,
  compositionPath: string, command: Command, args: Record<string, unknown>,
) {
  const requestId = String(args.requestId ?? '');
  const expectedRevision = String(args.expectedRevision ?? '');
  const expectedVersionId = String(args.expectedVersionId ?? '');
  if (!requestId || !expectedRevision || !expectedVersionId) {
    throw new CloudError('INVALID_ARGUMENT', 'Caption edits require requestId, expectedRevision and expectedVersionId.', { status: 400 });
  }
  const scope = `project:${projectId}:captions`;
  const inputHash = requestHash(args);
  const current = await files.readTextForCommand(auth, projectId, compositionPath, scope, requestId, inputHash);
  if (current.kind === 'replay') {
    return { projectId, compositionPath, ...current.commit.commandResult, revision: current.commit.revision };
  }
  const { content, count, trackId } = editCaptions(ops, current.content, command, args);
  const commit = await files.commitChanges(auth, {
    projectId, expectedRevision, expectedVersionId, requestId, idempotencyScope: scope,
    commandReceipt: { inputHash, result: { trackId, count } },
    ops: [{ op: 'upsert_text', path: compositionPath, content, stampHfIds: true }],
    source: 'agent', actorKind: 'agent', summary: `Edited captions in ${compositionPath}`,
  });
  return { projectId, compositionPath, ...commit.commandResult, revision: commit.revision };
}
