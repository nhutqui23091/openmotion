import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { phase1Tools } from '../../shared/phase1-tools.ts';
import {
  InMemoryAuthCache,
  InMemoryAuthStore,
  SESSION_COOKIE_NAME,
  createBrowserSession,
  createPat,
} from '../../src/auth/index.ts';
import {
  resolvePreviewTokenSecret,
  signPreviewToken,
  verifyPreviewToken,
} from '../../src/auth/preview-token.ts';
import { DEFAULT_PAT_SCOPES, type AuthContext } from '../../src/contracts/auth.ts';
import { CloudError } from '../../src/contracts/errors.ts';
import type { RenderWorkerHealth } from '../../src/contracts/events.ts';
import type {
  HeadObjectResult,
  ObjectStreamResult,
  PresignGetOptions,
  PresignPutOptions,
  StoragePort,
} from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import * as schema from '../../src/db/schema/index.ts';
import {
  createApiApp,
  resolveApiCorsAllowedOrigins,
  type ApiEventBusPort,
  type ApiQueuesPort,
  type CreateApiAppDeps,
} from '../../src/entrypoints/api.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { createLogger } from '../../src/infra/logger.ts';
import { InMemoryMcpSessionStore } from '../../src/mcp/index.ts';
import { MockModelGateway } from '../../src/services/mock-model-adapter.ts';
import type { WelcomeBootstrapService } from '../../src/services/welcome-bootstrap.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SILENT_LOGGER = createLogger({ level: 'error' });

// ---------------------------------------------------------------------------
// Deterministic In-Memory Drizzle PG + S3 + Redis + BullMQ Test Harness
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const UUID_TABLES = new Set([
  'workspaces',
  'sessions',
  'projects',
  'work_rounds',
  'project_versions',
  'project_history_entries',
  'assets',
  'asset_versions',
  'upload_tickets',
  'jobs',
]);

class ApiTestPgClient {
  readonly tables = new Map<string, Row[]>();
  private snap: Map<string, Row[]> | null = null;

  constructor() {
    for (const table of [
      'workspaces',
      'sessions',
      'session_messages',
      'projects',
      'project_grants',
      'work_rounds',
      'project_files',
      'project_versions',
      'project_version_files',
      'project_history_entries',
      'workspace_blobs',
      'catalog_templates',
      'catalog_template_files',
      'assets',
      'asset_versions',
      'upload_tickets',
      'jobs',
      'idempotency_receipts',
    ]) {
      this.tables.set(table, []);
    }
  }

  seed(table: string, row: Row): void {
    this.tables.get(table)!.push({ ...row });
  }

  rows(table: string): Row[] {
    return this.tables.get(table)!;
  }

  async query(
    config: string | { text: string; rowMode?: string },
    params: unknown[] = [],
  ): Promise<{ rows: unknown[] }> {
    const sqlText = (typeof config === 'string' ? config : config.text).trim();
    const rowMode = typeof config === 'string' ? undefined : config.rowMode;
    const upper = sqlText.toUpperCase();

    if (upper === 'SELECT 1') {
      return { rows: [rowMode === 'array' ? [1] : { '?column?': 1 }] };
    }
    if (upper === 'BEGIN' || upper.startsWith('BEGIN ')) {
      this.snap = new Map(
        [...this.tables.entries()].map(([k, v]) => [k, v.map((r) => structuredClone(r))]),
      );
      return { rows: [] };
    }
    if (upper === 'COMMIT') {
      this.snap = null;
      return { rows: [] };
    }
    if (upper === 'ROLLBACK') {
      if (this.snap) {
        this.tables.clear();
        for (const [k, v] of this.snap) this.tables.set(k, v);
        this.snap = null;
      }
      return { rows: [] };
    }
    if (upper.startsWith('SELECT ')) return this.select(sqlText, params, rowMode);
    if (upper.startsWith('INSERT INTO ')) return this.insert(sqlText, params, rowMode);
    if (upper.startsWith('UPDATE ')) return this.update(sqlText, params, rowMode);
    if (upper.startsWith('DELETE FROM ')) return this.del(sqlText, params, rowMode);
    throw new Error(`Unsupported SQL in ApiTestPgClient: ${sqlText}`);
  }

  private select(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const cleaned = sqlText.replace(/\s+for\s+update\s*$/i, '').trim();
    const m = /^select\s+([\s\S]+?)\s+from\s+"([^"]+)"([\s\S]*)$/i.exec(cleaned);
    if (!m) throw new Error(`Unsupported SELECT: ${sqlText}`);
    const selectList = m[1].trim();
    const table = m[2];
    let rem = m[3].trim();
    let limit: number | null = null;
    let offset = 0;
    let order = '';
    let where = '';

    const offM = /\s+offset\s+(\$\d+|\d+)\s*$/i.exec(rem);
    if (offM) {
      offset = offM[1].startsWith('$') ? Number(params[Number(offM[1].slice(1)) - 1]) : Number(offM[1]);
      rem = rem.slice(0, offM.index).trim();
    }
    const limM = /\s+limit\s+(\$\d+|\d+)\s*$/i.exec(rem);
    if (limM) {
      limit = limM[1].startsWith('$') ? Number(params[Number(limM[1].slice(1)) - 1]) : Number(limM[1]);
      rem = rem.slice(0, limM.index).trim();
    }
    const ordM = /\s+order\s+by\s+([\s\S]+)$/i.exec(rem);
    if (ordM) {
      order = ordM[1].trim();
      rem = rem.slice(0, ordM.index).trim();
    }
    const whM = /^where\s+([\s\S]+)$/i.exec(rem);
    if (whM) where = whM[1].trim();

    let matched = this.rows(table).filter((r) => (where ? evalW(r, where, params) : true));
    if (/^COALESCE\s*\(\s*MAX\s*\(/i.test(selectList)) {
      const col = /MAX\s*\(\s*"([^"]+)"\s*\)/i.exec(selectList)![1];
      const maxVal = matched.reduce((acc, r) => Math.max(acc, Number(r[col] ?? 0)), 0);
      return { rows: [rowMode === 'array' ? [maxVal] : { maxVal }] };
    }
    if (/^count\s*\(/i.test(selectList)) {
      return { rows: [rowMode === 'array' ? [matched.length] : { count: matched.length }] };
    }
    if (order) {
      const specs = splitTop(order, ',').map((p) => {
        const parts = p.trim().split(/\s+/);
        return { col: colName(parts[0]), dir: parts[1]?.toLowerCase() === 'desc' ? -1 : 1 };
      });
      matched = [...matched].sort((a, b) => {
        for (const s of specs) {
          const av = sortVal(a[s.col]);
          const bv = sortVal(b[s.col]);
          if (av < bv) return -s.dir;
          if (av > bv) return s.dir;
        }
        return 0;
      });
    }
    if (offset > 0) matched = matched.slice(offset);
    if (limit !== null) matched = matched.slice(0, limit);
    const cols = splitTop(selectList, ',').map(colName);
    return { rows: fmtRows(matched, cols, rowMode) };
  }

  private insert(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const confM = /\s+on\s+conflict\s*\(([^)]+)\)\s+do\s+(nothing|update\s+set\s+([\s\S]+))$/i.exec(noRet);
    const target = confM ? splitTop(confM[1], ',').map(colName) : null;
    const doNothing = Boolean(confM && confM[2].toLowerCase() === 'nothing');
    let setC = '';
    let whereC = '';
    if (confM && confM[3]) {
      const idx = findKw(confM[3].trim(), 'where');
      setC = idx >= 0 ? confM[3].trim().slice(0, idx).trim() : confM[3].trim();
      whereC = idx >= 0 ? confM[3].trim().slice(idx + 5).trim() : '';
    }
    const base = confM ? noRet.slice(0, confM.index).trim() : noRet;
    const hM = /^insert\s+into\s+"([^"]+)"\s*\(([^)]+)\)\s+values\s+([\s\S]+)$/i.exec(base);
    if (!hM) throw new Error(`Unsupported INSERT: ${sqlText}`);
    const table = hM[1];
    const cols = splitTop(hM[2], ',').map(colName);
    const tuples = splitTuples(hM[3].trim());
    const rows = this.rows(table);
    const out: Row[] = [];

    for (const tuple of tuples) {
      const exprs = splitTop(tuple, ',');
      const row: Row = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = evalInsVal(table, cols[i], exprs[i].trim(), params);
      }
      if (UUID_TABLES.has(table) && !row.id) row.id = randomUUID();
      if (table === 'projects') {
        if (!row.artifact_id) row.artifact_id = randomUUID();
        if (row.asset_name_allocations === undefined) row.asset_name_allocations = {};
        if (row.reviews === undefined) row.reviews = [];
        if (row.trashed === undefined) row.trashed = false;
        if (row.trashed_at === undefined) row.trashed_at = null;
      }
      if (table === 'workspace_blobs' && !row.gc_state) row.gc_state = 'active';
      if (target) {
        const existing = rows.find((r) => target.every((k) => r[k] === row[k]));
        if (existing) {
          if (doNothing) continue;
          if (whereC && !evalW(existing, whereC, params)) continue;
          applySet(existing, setC, params);
          out.push(existing);
          continue;
        }
      }
      rows.push(row);
      out.push(row);
    }
    return { rows: retCols ? fmtRows(out, retCols, rowMode) : [] };
  }

  private update(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const m = /^update\s+"([^"]+)"\s+set\s+([\s\S]+)$/i.exec(noRet);
    if (!m) throw new Error(`Unsupported UPDATE: ${sqlText}`);
    const table = m[1];
    const body = m[2].trim();
    const wIdx = findKw(body, 'where');
    const setC = wIdx >= 0 ? body.slice(0, wIdx).trim() : body;
    const whereC = wIdx >= 0 ? body.slice(wIdx + 5).trim() : '';
    const matched = this.rows(table).filter((r) => (whereC ? evalW(r, whereC, params) : true));
    for (const r of matched) applySet(r, setC, params);
    return { rows: retCols ? fmtRows(matched, retCols, rowMode) : [] };
  }

  private del(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const m = /^delete\s+from\s+"([^"]+)"(?:\s+where\s+([\s\S]+))?$/i.exec(noRet);
    if (!m) throw new Error(`Unsupported DELETE: ${sqlText}`);
    const table = m[1];
    const whereC = m[2]?.trim() ?? '';
    const kept: Row[] = [];
    const removed: Row[] = [];
    for (const r of this.rows(table)) {
      if (!whereC || evalW(r, whereC, params)) removed.push(r);
      else kept.push(r);
    }
    this.tables.set(table, kept);
    return { rows: retCols ? fmtRows(removed, retCols, rowMode) : [] };
  }
}

function colName(expr: string): string {
  const m = [...expr.trim().replace(/\s+as\s+"[^"]+"$/i, '').matchAll(/"([^"]+)"/g)];
  return m.length > 0 ? m[m.length - 1][1] : expr.trim();
}
function splitTop(input: string, sep: string): string[] {
  const out: string[] = [];
  let d = 0, sq = false, dq = false, st = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (d === 0 && input.slice(i, i + sep.length) === sep) {
        out.push(input.slice(st, i));
        st = i + sep.length;
        i += sep.length - 1;
      }
    }
  }
  out.push(input.slice(st));
  return out;
}
function splitTuples(input: string): string[] {
  const out: string[] = [];
  let d = 0, sq = false, dq = false, st = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') { if (d === 0) st = i + 1; d++; }
      else if (c === ')') { d--; if (d === 0 && st >= 0) { out.push(input.slice(st, i)); st = -1; } }
    }
  }
  return out;
}
function findKw(input: string, kw: string): number {
  const lo = input.toLowerCase();
  let d = 0, sq = false, dq = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (
        d === 0 &&
        lo.slice(i, i + kw.length) === kw &&
        (i === 0 || /\s/.test(input[i - 1])) &&
        (i + kw.length === input.length || /\s/.test(input[i + kw.length]))
      ) return i;
    }
  }
  return -1;
}
function evalSc(expr: string, params: unknown[]): unknown {
  const t = expr.trim();
  if (/^\$\d+$/.test(t)) {
    const v = params[Number(t.slice(1)) - 1];
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }
  if (/^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^now\(\)$/i.test(t)) return new Date().toISOString();
  if (/^'([^']*)'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}
function evalInsVal(table: string, col: string, expr: string, params: unknown[]): unknown {
  if (/^default$/i.test(expr)) {
    if (col === 'id' && UUID_TABLES.has(table)) return randomUUID();
    if (col === 'artifact_id') return randomUUID();
    if (col.endsWith('_at') || col === 'started_at' || col === 'ended_at') return new Date().toISOString();
    if (col === 'expires_at') return new Date(Date.now() + 86_400_000).toISOString();
    if (['pinned', 'undone', 'trashed', 'remote_terminal', 'save_pending'].includes(col)) return false;
    if (['current_version_number', 'current_history_seq', 'progress'].includes(col)) return 0;
    if (['asset_name_allocations', 'input_payload', 'default_models'].includes(col)) return {};
    if (col === 'reviews') return [];
    if (col === 'gc_state') return 'active';
    if (col === 'state') return table === 'jobs' ? 'queued' : 'pending';
    if (col === 'mode') return 'motion';
    return null;
  }
  return evalSc(expr, params);
}
function stripP(s: string): string {
  let out = s.trim();
  while (out.startsWith('(') && out.endsWith(')')) {
    let d = 0, ok = true;
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === '(') d++;
      else if (out[i] === ')') d--;
      if (d === 0) { ok = false; break; }
    }
    if (!ok) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}
function splitAnd(expr: string): string[] {
  const parts: string[] = [];
  let d = 0, sq = false, dq = false, st = 0;
  const lo = expr.toLowerCase();
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (
        d === 0 &&
        lo.slice(i, i + 3) === 'and' &&
        i > 0 && /\s/.test(expr[i - 1]) &&
        i + 3 < expr.length && /\s/.test(expr[i + 3])
      ) {
        parts.push(expr.slice(st, i).trim());
        st = i + 3;
        i += 2;
      }
    }
  }
  parts.push(expr.slice(st).trim());
  return parts;
}
function evalW(row: Row, raw: string, params: unknown[]): boolean {
  const terms = splitAnd(stripP(raw));
  if (terms.length > 1) return terms.every((t) => evalW(row, t, params));
  const term = stripP(terms[0]);
  let m: RegExpExecArray | null;
  if ((m = /^([\s\S]+?)\s+is\s+null$/i.exec(term))) return row[colName(m[1])] == null;
  if ((m = /^([\s\S]+?)\s+is\s+not\s+null$/i.exec(term))) return row[colName(m[1])] != null;
  if ((m = /^([\s\S]+?)\s+in\s*\(([\s\S]+)\)$/i.exec(term))) {
    return splitTop(m[2], ',').map((v) => evalSc(v, params)).includes(row[colName(m[1])]);
  }
  if ((m = /^([\s\S]+?)\s*>=\s*([\s\S]+)$/.exec(term))) return Number(row[colName(m[1])]) >= Number(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*>\s*([\s\S]+)$/.exec(term))) return Number(row[colName(m[1])]) > Number(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*<\s*([\s\S]+)$/.exec(term))) return Number(row[colName(m[1])]) < Number(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(term))) return row[colName(m[1])] === evalSc(m[2], params);
  throw new Error(`Unsupported WHERE: ${term}`);
}
function applySet(row: Row, setC: string, params: unknown[]): void {
  for (const a of splitTop(setC, ',')) {
    const eq = a.indexOf('=');
    if (eq < 0) continue;
    const col = colName(a.slice(0, eq));
    const rhs = a.slice(eq + 1).trim();
    let m: RegExpExecArray | null;
    if ((m = /"ref_count"\s*\+\s*(\$\d+)/i.exec(rhs))) {
      row[col] = Number(row.ref_count ?? 0) + Number(evalSc(m[1], params));
    } else if (!/^CASE\b/i.test(rhs) && (m = /"ref_count"\s*-\s*(\$\d+)/i.exec(rhs))) {
      row[col] = Number(row.ref_count ?? 0) - Number(evalSc(m[1], params));
    } else if (/CASE\s+WHEN[\s\S]*?"ref_count"/i.test(rhs)) {
      row[col] = Number(row.ref_count ?? 0) === 0 ? new Date().toISOString() : null;
    } else if ((m = /COALESCE\([\s\S]*?"metadata"[\s\S]*?\)\s*\|\|\s*(\$\d+)::jsonb/i.exec(rhs))) {
      const inc = evalSc(m[1], params);
      row[col] = { ...((row[col] as Record<string, unknown>) ?? {}), ...((inc as Record<string, unknown>) ?? {}) };
    } else {
      row[col] = evalSc(rhs, params);
    }
  }
}
function sortVal(v: unknown): string | number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v);
  return String(v ?? '');
}
function fmtRows(rows: readonly Row[], cols: readonly string[], rowMode?: string): unknown[] {
  return rows.map((r) =>
    rowMode === 'array'
      ? cols.map((c) => r[c] ?? null)
      : Object.fromEntries(cols.map((c) => [c, r[c] ?? null])),
  );
}

class InMemoryStorage implements StoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async putObject(key: string, body: Buffer | Uint8Array | Readable | string, contentType: string): Promise<void> {
    let buf: Buffer;
    if (Buffer.isBuffer(body)) {
      buf = Buffer.from(body);
    } else if (typeof body === 'string') {
      buf = Buffer.from(body, 'utf8');
    } else if (body instanceof Uint8Array) {
      buf = Buffer.from(body);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      buf = Buffer.concat(chunks);
    }
    this.objects.set(key, { body: buf, contentType });
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    if (this.objects.has(key)) return { uploaded: false };
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(found.body);
  }

  async getObjectStream(key: string): Promise<ObjectStreamResult> {
    const buf = await this.getObjectBuffer(key);
    return { stream: Readable.from([buf]), contentLength: buf.byteLength };
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    const sha = createHash('sha256').update(found.body).digest('hex');
    return {
      contentLength: found.body.byteLength,
      contentType: found.contentType,
      etag: `"${sha}"`,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        count++;
      }
    }
    return count;
  }

  async presignPut(key: string, _opts: PresignPutOptions): Promise<string> {
    return `https://s3.local.test/${encodeURIComponent(key)}?sig=put`;
  }

  async presignGet(key: string, opts?: PresignGetOptions): Promise<string> {
    const query = opts?.responseContentType
      ? `&ct=${encodeURIComponent(opts.responseContentType)}`
      : '';
    return `https://s3.local.test/${encodeURIComponent(key)}?sig=get${query}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

class InMemoryEventBus implements ApiEventBusPort {
  readonly published: Array<{ channel: string; payload: unknown }> = [];
  workersHealth: RenderWorkerHealth[] = [
    {
      workerId: 'render-worker-1',
      ffmpeg: true,
      ffprobe: true,
      chromium: true,
      concurrency: 2,
      activeJobs: 0,
      updatedAt: Date.now(),
    },
  ];
  healthy = true;
  private readonly channels = new Map<string, Set<(payload: unknown, ch: string) => void>>();

  async publish(channel: string, payload: unknown): Promise<number> {
    this.published.push({ channel, payload });
    const listeners = this.channels.get(channel);
    if (!listeners) return 0;
    for (const listener of listeners) listener(payload, channel);
    return listeners.size;
  }

  async subscribe(
    channel: string,
    listener: (payload: unknown, channel: string) => void,
  ): Promise<() => Promise<void>> {
    let bucket = this.channels.get(channel);
    if (!bucket) {
      bucket = new Set();
      this.channels.set(channel, bucket);
    }
    bucket.add(listener);
    return async () => {
      bucket?.delete(listener);
    };
  }

  async getRenderWorkersHealth(): Promise<RenderWorkerHealth[]> {
    return this.workersHealth;
  }

  async checkHealth(): Promise<boolean> {
    return this.healthy;
  }
}

function createFakeQueues(): { queues: ApiQueuesPort; enqueued: Array<{ queue: string; payload: unknown }> } {
  const enqueued: Array<{ queue: string; payload: unknown }> = [];
  const fakeQueue = {
    async getJob() {
      return null;
    },
  };
  const queues = {
    renderExport: fakeQueue as unknown as ApiQueuesPort['renderExport'],
    async enqueueMediaIngest(payload: unknown) {
      enqueued.push({ queue: 'media-ingest', payload });
      return { id: randomUUID() } as never;
    },
    async enqueueMediaGenerate(payload: unknown) {
      enqueued.push({ queue: 'media-generate', payload });
      return { id: randomUUID() } as never;
    },
    async enqueueRenderExport(payload: unknown) {
      enqueued.push({ queue: 'render-export', payload });
      return { id: randomUUID() } as never;
    },
  } as unknown as ApiQueuesPort;
  return { queues, enqueued };
}

function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'dev',
    DEV_PAT: 'om_pat_devlocal_123456789012345678901234',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud-client',
    OIDC_CLIENT_SECRET: 'ephemeral-test-client-secret',
    SESSION_SECRET: '0'.repeat(32),
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

function createApiFixture(overrides: {
  config?: Record<string, string | undefined>;
  deps?: Partial<CreateApiAppDeps>;
} = {}) {
  const config = makeConfig(overrides.config);
  const pgClient = new ApiTestPgClient();
  const db = drizzle({ client: pgClient as never, schema }) as unknown as Database;
  const storage = new InMemoryStorage();
  const eventBus = new InMemoryEventBus();
  const { queues, enqueued } = createFakeQueues();
  const authStore = new InMemoryAuthStore();
  const authCache = new InMemoryAuthCache();
  const gateway = new MockModelGateway();
  const mcpSessionStore = new InMemoryMcpSessionStore();

  // Seed default workspace row in PG for services that query `workspaces` directly.
  pgClient.seed('workspaces', {
    id: config.DEV_WORKSPACE_ID,
    slug: 'dev-workspace',
    name: 'Local Dev Workspace',
    owner_user_id: config.DEV_USER_ID,
    active_project_id: null,
    default_models: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const welcomeCalls: string[] = [];
  let welcomeThrowNotFound = false;
  const fakeWelcomeBootstrap = {
    async ensureWelcomeProject(auth: AuthContext) {
      welcomeCalls.push(auth.workspaceId);
      if (welcomeThrowNotFound) {
        throw new CloudError('NOT_FOUND', 'Welcome template not synced', { status: 404, applied: false });
      }
      return { created: false, projectId: '00000000-0000-4000-8000-000000000099' };
    },
  } as unknown as WelcomeBootstrapService;

  const { app, services } = createApiApp({
    config,
    db,
    storage,
    queues,
    eventBus,
    authStore,
    authCache,
    gateway,
    mcpSessionStore,
    welcomeBootstrap: fakeWelcomeBootstrap,
    logger: SILENT_LOGGER,
    runtimeRoot: REPO_ROOT,
    ...overrides.deps,
  });

  return {
    app,
    services,
    config,
    pgClient,
    storage,
    eventBus,
    enqueued,
    authStore,
    authCache,
    welcomeCalls,
    setWelcomeThrowNotFound(value: boolean) {
      welcomeThrowNotFound = value;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated Health Probes
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Health Probes', () => {
  it('serves /api/health/live (200), /api/health/ready (200 healthy, 503 degraded), and /api/health', async () => {
    let pgOk = true;
    let redisOk = true;
    let s3Ok = true;

    const { app } = createApiFixture({
      config: { AUTH_MODE: 'oidc' },
      deps: {
        checkDbHealth: async () => pgOk,
        checkRedisHealth: async () => redisOk,
        checkStorageHealth: async () => s3Ok,
      },
    });

    const liveRes = await app.request('/api/health/live');
    assert.equal(liveRes.status, 200);
    const live = (await liveRes.json()) as { ok: boolean; status: string; service: string };
    assert.equal(live.ok, true);
    assert.equal(live.status, 'live');
    assert.equal(live.service, 'api');

    const readyRes = await app.request('/api/health/ready');
    assert.equal(readyRes.status, 200);
    const ready = (await readyRes.json()) as {
      ok: boolean;
      status: string;
      checks: { postgres: boolean; redis: boolean; storage: boolean };
    };
    assert.equal(ready.ok, true);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.checks, { postgres: true, redis: true, storage: true });

    const healthRes = await app.request('/api/health');
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      mcp: { protocol: number; tools: string[] };
    };
    assert.equal(health.ok, true);
    assert.equal(health.mcp.protocol, 1);
    assert.equal(health.mcp.tools.length, 22);

    // Degrade Redis -> /api/health/ready must return 503 while /api/health/live stays 200.
    redisOk = false;
    const degradedRes = await app.request('/api/health/ready');
    assert.equal(degradedRes.status, 503);
    const degraded = (await degradedRes.json()) as {
      ok: boolean;
      status: string;
      checks: { postgres: boolean; redis: boolean; storage: boolean };
    };
    assert.equal(degraded.ok, false);
    assert.equal(degraded.status, 'not_ready');
    assert.deepEqual(degraded.checks, { postgres: true, redis: false, storage: true });

    const stillLive = await app.request('/api/health/live');
    assert.equal(stillLive.status, 200);

    // Degrade Postgres and S3 as well.
    pgOk = false;
    s3Ok = false;
    const allDown = await app.request('/api/health/ready');
    assert.equal(allDown.status, 503);
  });
});

// ---------------------------------------------------------------------------
// 2. Dual-Mode Auth, OAuth 2.1 Discovery, Bearer-Only /mcp & Welcome Bootstrap
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Auth Isolation & First-Access Welcome Bootstrap', () => {
  it('enforces AUTH_MODE=oidc on protected APIs, rejects browser cookie on /mcp, and accepts PAT Bearer', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'oidc' } });
    const { app, authStore, pgClient } = fixture;

    // Unauthenticated API requests -> 401
    for (const url of [
      '/motion-api/projects',
      '/api/projects',
      `/api/media-jobs/${randomUUID()}/progress`,
      '/motion-api/models',
      '/motion-api/account/summary',
      '/motion-api/integration',
    ]) {
      const res = await app.request(url);
      assert.equal(res.status, 401, `expected 401 for unauthenticated ${url}`);
    }

    // OAuth 2.1 discovery endpoints are public
    const prmRes = await app.request('/.well-known/oauth-protected-resource');
    assert.equal(prmRes.status, 200);
    const prm = (await prmRes.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, 'https://motion.example.test/mcp');
    assert.ok(prm.authorization_servers.length >= 1);

    const asMetaRes = await app.request('/.well-known/oauth-authorization-server');
    assert.equal(asMetaRes.status, 200);

    // Provision an OIDC user + workspace
    const userId = randomUUID();
    const workspaceId = randomUUID();
    authStore.seedWorkspace({
      workspaceId,
      userId,
      oidcSub: 'oidc-sub-integration-1',
      email: 'creator@example.test',
      displayName: 'Creator One',
      role: 'owner',
      slug: 'creator-ws',
      name: 'Creator Workspace',
    });
    pgClient.seed('workspaces', {
      id: workspaceId,
      slug: 'creator-ws',
      name: 'Creator Workspace',
      owner_user_id: userId,
      active_project_id: null,
      default_models: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Browser session cookie works on product & Studio APIs
    const browserSession = await createBrowserSession(authStore, { userId, workspaceId });
    const projectsRes = await app.request('/motion-api/projects', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` },
    });
    assert.equal(projectsRes.status, 200);

    // First-access welcome bootstrap ran exactly once for workspaceId and cached for subsequent requests
    assert.deepEqual(fixture.welcomeCalls, [workspaceId]);
    const secondRes = await app.request('/motion-api/account/summary', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` },
    });
    assert.equal(secondRes.status, 200);
    assert.deepEqual(fixture.welcomeCalls, [workspaceId]);

    // Browser cookie is STRICTLY REJECTED on /mcp (RFC 9728 Bearer challenge)
    const mcpCookieRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcpCookieRes.status, 401);
    assert.match(
      mcpCookieRes.headers.get('www-authenticate') ?? '',
      /Bearer\s+resource_metadata="https:\/\/motion\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    // PAT Bearer token succeeds on /mcp AND /motion-api/projects
    const ownerAuth: AuthContext = {
      workspaceId,
      userId,
      role: 'owner',
      scopes: [...DEFAULT_PAT_SCOPES],
      authMode: 'oidc',
      authMethod: 'session_cookie',
    };
    const writeOnly = await createPat(authStore, ownerAuth, { name: 'Write only', scopes: ['projects:write'] });
    for (const resource of ['projects', 'sessions']) {
      const restricted = await app.request(`/motion-api/${resource}/${randomUUID()}/open?view=editor`, {
        method: 'POST', headers: { Authorization: `Bearer ${writeOnly.token}` },
      });
      assert.equal(restricted.status, 403);
      assert.equal((await restricted.json()).code, 'INSUFFICIENT_SCOPE');
    }
    const createdPat = await createPat(authStore, ownerAuth, {
      name: 'Integration Test PAT',
      scopes: [...DEFAULT_PAT_SCOPES],
    });

    const mcpPatRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createdPat.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(mcpPatRes.status, 200);
    assert.ok(mcpPatRes.headers.get('mcp-session-id'));
  });

  it('survives unsynced welcome template (NOT_FOUND) gracefully during AUTH_MODE=dev workspace access', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    fixture.setWelcomeThrowNotFound(true);

    const res = await fixture.app.request('/motion-api/projects');
    assert.equal(res.status, 200);
    assert.equal(fixture.welcomeCalls.length, 1);

    // Since welcome template was not synced, it was NOT cached as bootstrapped.
    fixture.setWelcomeThrowNotFound(false);
    const res2 = await fixture.app.request('/motion-api/projects');
    assert.equal(res2.status, 200);
    assert.equal(fixture.welcomeCalls.length, 2);

    // Once bootstrapped, subsequent requests hit the in-memory cache.
    const res3 = await fixture.app.request('/motion-api/projects');
    assert.equal(res3.status, 200);
    assert.equal(fixture.welcomeCalls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-End Wired Product + Diskless Studio + Streamable HTTP /mcp
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — End-to-End Product, Studio & Streamable HTTP /mcp', () => {
  it('creates a project, edits via /mcp, reads via Diskless Studio, and enforces MCP limits & P2 codes', async () => {
    const { app, config, pgClient } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const mcpHeaders = {
      Authorization: `Bearer ${config.DEV_PAT}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    // 1. Create a project via /motion-api/projects
    const createRes = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cloud API E2E Video' }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      projectId: string;
      title: string;
      revision: string;
      versionId: string;
    };
    const projectId = created.projectId;
    assert.ok(projectId);
    assert.equal(created.title, 'Cloud API E2E Video');
    assert.ok(created.revision);
    assert.ok(created.versionId);

    // 2. Verify Diskless Studio sees the project and serves index.html with ETag
    const studioListRes = await app.request('/api/projects');
    assert.equal(studioListRes.status, 200);
    const studioList = (await studioListRes.json()) as { projects: Array<{ id: string }> };
    assert.ok(studioList.projects.some((p) => p.id === projectId));

    const indexRes = await app.request(`/api/projects/${projectId}/files/index.html`);
    assert.equal(indexRes.status, 200);
    assert.ok(indexRes.headers.get('etag'));
    const indexHtml = await indexRes.text();
    assert.match(indexHtml, /<html/i);

    // 3. Initialize Streamable HTTP MCP session
    const initRes = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'api-e2e-client', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Mcp-Session-Id header must be issued on initialize');

    const callMcp = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { ...mcpHeaders, 'Mcp-Session-Id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      assert.equal(res.status, 200, `MCP ${method} expected 200, got ${res.status}`);
      return (await res.json()) as {
        jsonrpc: string;
        id: number;
        result?: Record<string, unknown>;
        error?: { code: number; message: string };
      };
    };

    // 4. tools/list must advertise all 22 registered domain openmotion_* tools
    const listPayload = await callMcp(2, 'tools/list');
    const tools = (listPayload.result?.tools ?? []) as Array<{ name: string; description: string }>;
    assert.equal(tools.length, phase1Tools.length);
    assert.equal(tools.length, 22);
    const transcriptGuide = tools.find(tool => tool.name === 'openmotion_assets_use')?.description;
    assert.ok(transcriptGuide);
    assert.match(transcriptGuide, /Cloud ASR submit\/status is unavailable/);
    assert.match(transcriptGuide, /your own execution environment[\s\S]+ffmpeg[\s\S]+speech-to-text[\s\S]+caption_add/);

    // MCP discovery returns the whole index, including entries beyond Studio's page limit.
    const templateIds = Array.from({ length: 501 }, (_, i) => `mcp-template-${i}`);
    for (const [sortOrder, id] of templateIds.entries()) {
      pgClient.seed('catalog_templates', {
        id, kind: 'builtin', sort_order: sortOrder, catalog_version: 'mcp-e2e',
        metadata: { title: id }, updated_at: new Date().toISOString(),
      });
    }
    const catalog = await callMcp(20, 'tools/call', { name: 'openmotion_list_templates', arguments: {} });
    assert.equal(catalog.result?.isError, undefined);
    const index = catalog.result?.structuredContent as {
      catalogVersion: string; total: number; templates: Array<{ id: string }>;
    };
    assert.equal(index.catalogVersion, 'mcp-e2e');
    assert.equal(index.total, templateIds.length);
    assert.deepEqual(index.templates.map(template => template.id), templateIds);

    // 5. openmotion_get_project (without projectId) lists workspace projects including our created one
    const listProjectsRes = await callMcp(3, 'tools/call', {
      name: 'openmotion_get_project',
      arguments: {},
    });
    assert.equal(listProjectsRes.result?.isError, undefined);
    const listStructured = listProjectsRes.result?.structuredContent as {
      projects: Array<{ projectId?: string; id?: string }>;
    };
    assert.ok(listStructured.projects.some((p) => (p.projectId ?? p.id) === projectId));

    // 6. openmotion_edit_project writes notes.txt and advances revision
    const editRes = await callMcp(4, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-edit-1',
        expectedRevision: created.revision,
        expectedVersionId: created.versionId,
        summary: 'Add integration test notes',
        files: [{ path: 'notes.txt', content: 'Hello from cloud MCP' }],
      },
    });
    assert.equal(editRes.result?.isError, undefined);
    const editStructured = editRes.result?.structuredContent as {
      revision: string;
      version: { versionId: string; versionNumber: number };
    };
    assert.notEqual(editStructured.revision, created.revision);
    assert.ok(editStructured.version.versionNumber >= 2);

    // 6b. Regression: openmotion_edit_project MUST enforce optimistic locking on assetNames-only edits
    const staleRevAssetNames = await callMcp(41, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-asset-names-stale-rev',
        expectedRevision: '0'.repeat(64),
        expectedVersionId: editStructured.version.versionId,
        assetNames: [{ path: 'assets/hero.png', name: 'Hero Frame' }],
      },
    });
    assert.equal(staleRevAssetNames.result?.isError, true);
    assert.equal(
      (staleRevAssetNames.result?.structuredContent as { error: { code: string } }).error.code,
      'VERSION_CONFLICT',
    );

    const staleVerAssetNames = await callMcp(42, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-asset-names-stale-ver',
        expectedRevision: editStructured.revision,
        expectedVersionId: randomUUID(),
        assetNames: [{ path: 'assets/hero.png', name: 'Hero Frame' }],
      },
    });
    assert.equal(staleVerAssetNames.result?.isError, true);
    assert.equal(
      (staleVerAssetNames.result?.structuredContent as { error: { code: string } }).error.code,
      'VERSION_CONFLICT',
    );

    const validAssetNames = await callMcp(43, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-asset-names-ok',
        expectedRevision: editStructured.revision,
        expectedVersionId: editStructured.version.versionId,
        assetNames: [{ path: 'assets/hero.png', name: 'Hero Frame' }],
      },
    });
    assert.equal(validAssetNames.result?.isError, undefined);
    const assetNamesStructured = validAssetNames.result?.structuredContent as { revision: string };
    assert.notEqual(assetNamesStructured.revision, editStructured.revision);

    // 7. openmotion_get_project reads back notes.txt written via MCP
    const readRes = await callMcp(5, 'tools/call', {
      name: 'openmotion_get_project',
      arguments: { projectId, file: { path: 'notes.txt' } },
    });
    assert.equal(readRes.result?.isError, undefined);
    const readStructured = readRes.result?.structuredContent as {
      file?: { content?: string };
      content?: string;
    };
    assert.equal(readStructured.file?.content ?? readStructured.content, 'Hello from cloud MCP');

    // 8. openmotion_media_use(models) returns MockModelGateway models
    const mediaModels = await callMcp(6, 'tools/call', {
      name: 'openmotion_media_use',
      arguments: { action: 'models' },
    });
    assert.equal(mediaModels.result?.isError, undefined);
    const mediaStructured = mediaModels.result?.structuredContent as {
      provider: string;
      models: unknown[];
    };
    assert.equal(mediaStructured.provider, 'opendesign');
    assert.ok(Array.isArray(mediaStructured.models) && mediaStructured.models.length > 0);

    // 9. openmotion_list_skills & openmotion_open_preview(templates)
    const skillsRes = await callMcp(7, 'tools/call', {
      name: 'openmotion_list_skills',
      arguments: {},
    });
    assert.equal(skillsRes.result?.isError, undefined);

    const previewRes = await callMcp(8, 'tools/call', {
      name: 'openmotion_open_preview',
      arguments: { target: 'templates' },
    });
    assert.equal(previewRes.result?.isError, undefined);
    const previewStructured = previewRes.result?.structuredContent as {
      url?: string;
      previewUrl?: string;
    };
    assert.ok(
      (previewStructured.url ?? previewStructured.previewUrl ?? '').startsWith(
        'https://motion.example.test/',
      ),
    );

    // 10. Legacy sourcePath on openmotion_import_assets -> LOCAL_PATH_UNSUPPORTED_IN_CLOUD
    const legacyImport = await callMcp(9, 'tools/call', {
      name: 'openmotion_import_assets',
      arguments: {
        projectId,
        requestId: 'req-e2e-legacy-import',
        items: [{ itemId: 'item-1', sourcePath: '/tmp/local-file.png' }],
      },
    });
    assert.equal(legacyImport.result?.isError, true);
    const legacyStructured = legacyImport.result?.structuredContent as { error: { code: string } };
    assert.equal(legacyStructured.error.code, 'LOCAL_PATH_UNSUPPORTED_IN_CLOUD');

    // 11. P2 deferred MCP tools return structured FEATURE_DEFERRED_P2
    const designRes = await callMcp(10, 'tools/call', {
      name: 'openmotion_design_project',
      arguments: { action: 'list' },
    });
    assert.equal(designRes.result?.isError, true);
    assert.equal(
      (designRes.result?.structuredContent as { error: { code: string } }).error.code,
      'FEATURE_DEFERRED_P2',
    );

    const commentsRes = await callMcp(11, 'tools/call', {
      name: 'openmotion_manage_project',
      arguments: { action: 'comments', projectId },
    });
    assert.equal(commentsRes.result?.isError, true);
    assert.equal(
      (commentsRes.result?.structuredContent as { error: { code: string } }).error.code,
      'FEATURE_DEFERRED_P2',
    );

    // 12. MCP_MAX_BODY_BYTES limit enforcement (413)
    const smallLimitFixture = createApiFixture({
      config: { AUTH_MODE: 'dev', MCP_MAX_BODY_BYTES: '1048576' },
    });
    const oversizedRes = await smallLimitFixture.app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${smallLimitFixture.config.DEV_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_050_000) }),
    });
    assert.equal(oversizedRes.status, 413);

    // 13. DELETE /mcp tears down session cleanly
    const deleteRes = await app.request('/mcp', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${config.DEV_PAT}`,
        'Mcp-Session-Id': sessionId,
      },
    });
    assert.equal(deleteRes.status, 204);
  });
});

// ---------------------------------------------------------------------------
// 4. Models, Account, Catalog, Integration, Environment & P2 Deferred Routes
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Models, Account, Catalog, Integration & P2 Routes', () => {
  it('wires /motion-api/models, /motion-api/account, /motion-api/integration, catalog & P2 501 routes', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });

    // Models & account
    const modelsRes = await app.request('/motion-api/models');
    assert.equal(modelsRes.status, 200);
    const modelsBody = (await modelsRes.json()) as { provider: string; mode: string; models: unknown[] };
    assert.equal(modelsBody.provider, 'opendesign');
    assert.equal(modelsBody.mode, 'mock');
    assert.ok(modelsBody.models.length > 0);

    const accountRes = await app.request('/motion-api/account/summary');
    assert.equal(accountRes.status, 200);
    const account = (await accountRes.json()) as {
      authenticated: boolean;
      modelGateway: { provider: string; mode: string };
    };
    assert.equal(account.authenticated, true);
    assert.equal(account.modelGateway.provider, 'opendesign');

    // Integration & connect endpoints
    const integrationRes = await app.request('/motion-api/integration');
    assert.equal(integrationRes.status, 200);
    const integration = (await integrationRes.json()) as {
      transport?: { type?: string; url?: string };
      tools?: unknown[];
    };
    assert.equal(integration.transport?.type, 'streamable-http');
    assert.equal(integration.transport?.url, 'https://motion.example.test/mcp');
    assert.equal(integration.tools?.length, 22);

    const cfgRes = await app.request('/connect/config?host=codex');
    assert.equal(cfgRes.status, 200);
    assert.match(await cfgRes.text(), /https:\/\/motion\.example\.test\/mcp/);

    const guideRes = await app.request('/connect/guide?host=codex');
    assert.equal(guideRes.status, 200);
    assert.match(await guideRes.text(), /motion\.example\.test/);

    // Public catalog listing on BOTH /api/templates and /motion-api/templates
    const apiTemplatesRes = await app.request('/api/templates');
    assert.equal(apiTemplatesRes.status, 200);
    const motionTemplatesRes = await app.request('/motion-api/templates');
    assert.equal(motionTemplatesRes.status, 200);

    // Runtime & Diskless environment probes
    const runtimeRes = await app.request('/motion-api/runtime');
    assert.equal(runtimeRes.status, 200);
    assert.equal(((await runtimeRes.json()) as { mode: string }).mode, 'cloud-container');

    const ffmpegRes = await app.request('/api/environment/ffmpeg');
    assert.equal(ffmpegRes.status, 200);
    const ffmpeg = (await ffmpegRes.json()) as { available: boolean; workerCount?: number };
    assert.equal(ffmpeg.available, true);

    // Regression: /api/media-jobs/:jobId/progress has auth middleware wired (reaches handler -> 404, never 401)
    const mediaJobProgress = await app.request(`/api/media-jobs/${randomUUID()}/progress`);
    assert.equal(mediaJobProgress.status, 404);

    // Regression: createApiApp wires authCache into OpenDesignModelGateway when MODEL_GATEWAY_MODE=opendesign
    const cachedAuthCache = new InMemoryAuthCache();
    await cachedAuthCache.set(
      'om:gateway:models:global',
      JSON.stringify([
        {
          id: 'opendesign:cached-image-1',
          provider: 'opendesign',
          modelId: 'cached-image-1',
          label: 'Cached Test Image',
          modality: 'image',
          mode: 'text-to-image',
          modes: ['text-to-image'],
          supportsImageReference: false,
          options: [],
        },
      ]),
      300,
    );
    const liveGwFixture = createApiFixture({
      config: {
        AUTH_MODE: 'dev',
        MODEL_GATEWAY_MODE: 'opendesign',
        OPENDESIGN_API_URL: 'https://api.opendesign.invalid',
        OPENDESIGN_S2S_API_KEY: 'ephemeral-test-s2s-key',
      },
      deps: {
        gateway: undefined,
        authCache: cachedAuthCache,
      },
    });
    const cachedModelsRes = await liveGwFixture.app.request('/motion-api/models');
    assert.equal(cachedModelsRes.status, 200);
    const cachedModelsBody = (await cachedModelsRes.json()) as {
      mode: string;
      models: Array<{ id: string }>;
    };
    assert.equal(cachedModelsBody.mode, 'opendesign');
    assert.deepEqual(
      cachedModelsBody.models.map((m) => m.id),
      ['opendesign:cached-image-1'],
    );

    const desktopGet = await app.request('/api/open-in-desktop');
    assert.equal(desktopGet.status, 200);
    assert.equal(((await desktopGet.json()) as { available: boolean }).available, false);

    const desktopPost = await app.request('/api/open-in-desktop', { method: 'POST' });
    assert.equal(desktopPost.status, 501);

    // Explicit P2 501 FEATURE_DEFERRED_P2 HTTP routes
    for (const [method, url] of [
      ['GET', '/motion-api/design/projects'],
      ['POST', '/motion-api/brand-kits'],
      ['GET', '/motion-api/transcripts'],
      ['GET', '/motion-api/review-comments'],
    ] as const) {
      const res = await app.request(url, { method });
      assert.equal(res.status, 501, `expected 501 for ${method} ${url}`);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'FEATURE_DEFERRED_P2');
    }

    // Static read-only Brand Kit catalog JSON remains available (200)
    const brandCatalogRes = await app.request('/motion-api/brand-kits/catalog');
    assert.equal(brandCatalogRes.status, 200);
    const brandCatalog = (await brandCatalogRes.json()) as { entries: unknown[] };
    assert.ok(Array.isArray(brandCatalog.entries));
  });
});

// ---------------------------------------------------------------------------
// 5. Static Design System, Read-Only GSAP Vendor, Studio Runtime & SPA Fallback
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Static Assets, Read-Only GSAP & API 404 vs SPA Fallback', () => {
  it('serves design-system assets, GSAP vendor bundle, runtime.js, inline-video.html, and separates API 404 from SPA fallback', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });

    const tokensRes = await app.request('/design-system/tokens.css');
    assert.equal(tokensRes.status, 200);
    assert.match(tokensRes.headers.get('content-type') ?? '', /^text\/css/);

    const fontRes = await app.request('/web/design-system/fonts/AlbertSans-VariableFont_wght.ttf');
    assert.equal(fontRes.status, 200);
    assert.equal(fontRes.headers.get('access-control-allow-origin'), '*');

    const runtimeJsRes = await app.request('/api/runtime.js');
    assert.equal(runtimeJsRes.status, 200);
    assert.match(runtimeJsRes.headers.get('content-type') ?? '', /javascript/);

    const gsapRes = await app.request('/api/vendor/gsap/gsap.min.js');
    assert.equal(gsapRes.status, 200);
    assert.match(gsapRes.headers.get('content-type') ?? '', /javascript/);

    const gsapVersionedPluginRes = await app.request(
      '/api/vendor/gsap/gsap@3.15.0/dist/MotionPathPlugin.min.js',
    );
    assert.equal(gsapVersionedPluginRes.status, 200);
    assert.match(gsapVersionedPluginRes.headers.get('content-type') ?? '', /javascript/);

    const gsapTraversal = await app.request('/api/vendor/gsap/%2e%2e/%2e%2e/package.json');
    assert.ok(gsapTraversal.status === 400 || gsapTraversal.status === 404);

    const gsapVersionedTraversal = await app.request(
      '/api/vendor/gsap/gsap@3.15.0/dist/%2e%2e/%2e%2e/package.json',
    );
    assert.ok(gsapVersionedTraversal.status === 400 || gsapVersionedTraversal.status === 404);

    const hfConfigRes = await app.request('/__hyperframes_config');
    assert.equal(hfConfigRes.status, 200);
    const hfConfig = (await hfConfigRes.json()) as { diskless?: boolean };
    assert.equal(hfConfig.diskless, true);

    const inlineVideoJs = await app.request('/web/inline-video.js');
    assert.equal(inlineVideoJs.status, 200);
    assert.match(inlineVideoJs.headers.get('content-type') ?? '', /javascript/);

    const finalVideoComp = await app.request('/web/final-video-component.js');
    assert.equal(finalVideoComp.status, 200);
    assert.match(finalVideoComp.headers.get('content-type') ?? '', /javascript/);

    const mcpUiFragment = await app.request('/mcp-ui/template-recommendations/inline.fragment.html');
    assert.equal(mcpUiFragment.status, 200);
    assert.match(mcpUiFragment.headers.get('content-type') ?? '', /^text\/html/);

    // Unknown API paths MUST return JSON 404 (never SPA HTML)
    for (const apiPath of ['/api/does-not-exist', '/motion-api/does-not-exist']) {
      const res = await app.request(apiPath);
      assert.equal(res.status, 404, `expected 404 for ${apiPath}`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'NOT_FOUND');
    }

    // SPA client-side route serves studio/build/index.html (200) or clean 503 if unbuilt
    const spaRes = await app.request('/projects/client-route');
    const studioBuilt = existsSync(path.join(REPO_ROOT, 'studio/build/index.html'));
    assert.equal(spaRes.status, studioBuilt ? 200 : 503);
  });
});

// ---------------------------------------------------------------------------
// 6. Studio UI ↔ Cloud Backend Wiring Parity Regressions (#74 / #75)
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Studio UI Wiring Parity (/preview/open, WorkspaceStatus, /phase1/call, /generations, /tracking/preferences)', () => {
  it('replays caption commands with the original track and guards both project versions', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (path: string, data: unknown) => app.request('/motion-api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    const { projectId } = await (await post('projects', { title: 'Caption retries' })).json();
    const call = (name: string, args: unknown) => post('phase1/call', { name, arguments: args });
    const project = async () => (await call('openmotion_get_project', { projectId })).json();
    const caption = (command: string, params: Record<string, unknown> = {}) => call('openmotion_assets_use', {
      action: 'transcript', transcript: { projectId, compositionPath: 'index.html', command, ...params },
    });
    const { revision, currentVersionId } = await project();
    const original = { expectedRevision: revision, expectedVersionId: currentVersionId,
      requestId: 'add-cue', segments: [{ id: 'c1', text: 'Hello', start: 0, end: 1 }] };
    const invalid = await caption('caption_add', { ...original, expectedVersionId: randomUUID() });
    assert.equal(invalid.status, 409);
    const added = await caption('caption_add', original);
    assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
    const first = await added.json();
    assert.ok(first.trackId);
    assert.equal(first.count, 1);
    const current = await project();
    const hide = { expectedVersionId: current.currentVersionId, expectedRevision: current.revision,
      requestId: 'hide-captions', visible: false };
    const hidden = await caption('caption_toggle', hide);
    assert.equal(hidden.status, 200);
    assert.equal((await hidden.json()).trackId, first.trackId);
    const tracks = await (await caption('caption_tracks')).json();
    assert.equal(tracks.tracks.length, 1);
    assert.equal(tracks.tracks[0].settings.visible, false);

    const hiddenVersion = (await project()).currentVersionId;
    const reordered = { ...original, segments: [{ end: 1, start: 0, text: 'Hello', id: 'c1' }] };
    assert.deepEqual(await (await caption('caption_add', reordered)).json(), first);
    const afterRetry = await project();
    assert.equal(afterRetry.currentVersionId, hiddenVersion);
    const mismatch = await caption('caption_add', { ...original, segments: [{ id: 'c1', text: 'Changed', start: 0, end: 1 }] });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).code, 'REQUEST_ID_CONFLICT');
  });

  it('switches editor routes without loading messages, export jobs or a second copy of the target', async t => {
    const { app, services, pgClient, config } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const post = (path: string, body?: Record<string, string>) => app.request('/motion-api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    const source = await (await post('projects', { title: 'Source' })).json();
    const target = await (await post('projects', { title: 'Target' })).json();
    const empty = await (await post('sessions', { title: 'Draft' })).json();
    const detailRead = t.mock.method(services.workspace, 'getSession');
    const projectRead = t.mock.method(services.workspace, 'getProject');
    const exportsRead = t.mock.method(services.exports, 'listProjectExports');
    const editorView = '?view=editor&projectId=' + source.projectId;
    const expected = {
      projectId: target.projectId, sessionId: target.sessionId,
      artifact: { id: target.artifactId, kind: 'motion-project', projectId: target.projectId, title: 'Target' },
    };

    for (const [path, body] of [
      [`projects/${target.projectId}/open`, undefined],
      [`sessions/${target.sessionId}/open`, { projectId: target.projectId }],
      [`sessions/${target.sessionId}/open`, undefined],
    ] as const) {
      const res = await post(path + editorView, body);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), expected);
    }
    const draft = await post(`sessions/${empty.sessionId}/open` + editorView);
    assert.equal(draft.status, 200);
    assert.deepEqual(await draft.json(), { projectId: '', sessionId: empty.sessionId, artifact: null });
    assert.equal(detailRead.mock.callCount(), 0);
    assert.equal(projectRead.mock.callCount(), 0);
    assert.equal(exportsRead.mock.callCount(), 0);

    const activeSession = () => pgClient.rows('workspaces').find(row => row.id === config.DEV_WORKSPACE_ID)?.active_session_id;
    assert.equal(activeSession(), empty.sessionId);
    const crossSession = await post(`sessions/${target.sessionId}/open` + editorView, { projectId: source.projectId });
    assert.equal(crossSession.status, 404);
    for (const path of [`projects/${target.projectId}/open`, `sessions/${target.sessionId}/open`]) {
      assert.equal((await post(path + '?view=editor&projectId=' + randomUUID())).status, 404);
    }
    assert.equal(activeSession(), empty.sessionId);
    await post(`projects/${target.projectId}/trash`);
    assert.equal((await post(`projects/${target.projectId}/open` + editorView)).status, 400);
    assert.equal((await post(`sessions/${target.sessionId}/open` + editorView, { projectId: target.projectId })).status, 404);
    // A project trashed in another tab must still allow leaving for an accessible target.
    for (const path of [`projects/${source.projectId}/open`, `sessions/${source.sessionId}/open`]) {
      assert.equal((await post(path + '?view=editor&projectId=' + target.projectId)).status, 200);
    }
  });

  it('supports Studio project/session/template navigation, /motion-api/preview/open, /motion-api/phase1/call, /generations, and /tracking/preferences', async (t) => {
    const { app, pgClient, storage, services } = createApiFixture({ config: { AUTH_MODE: 'dev' } });

    // Seed one catalog template so POST /motion-api/templates/:id/open can clone with expectedRevision/expectedProjectId.
    const tplHtml = Buffer.from('<div data-composition-id="main">Template</div>', 'utf8');
    const tplSha = createHash('sha256').update(tplHtml).digest('hex');
    await storage.putBlobIfAbsent(`catalog/blobs/${tplSha}`, tplHtml, 'text/html');
    pgClient.seed('catalog_templates', {
      id: 'studio-smoke-tpl',
      kind: 'builtin',
      catalog_version: 'v1',
      sort_order: 1,
      featured_order: 1,
      has_html_project: true,
      metadata: { title: 'Smoke Template', category: 'featured', durationSec: 3, width: 1280, height: 720, fps: 30 },
      instructions_md: null,
      motion_md: null,
      updated_at: new Date().toISOString(),
    });
    pgClient.seed('catalog_template_files', {
      template_id: 'studio-smoke-tpl',
      path: 'index.html',
      sha256: tplSha,
      size_bytes: tplHtml.byteLength,
      mime_type: 'text/html',
      metadata: null,
      is_project_file: true,
      is_available: true,
    });

    // 1. POST /motion-api/projects (accepts instruction + returns WorkspaceStatus fields)
    const createProjRes = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Studio Parity Film', instruction: 'Opening prompt' }),
    });
    assert.equal(createProjRes.status, 201);
    const createdProj = (await createProjRes.json()) as {
      projectId: string;
      artifactId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.ok(createdProj.projectId);
    assert.equal(createdProj.projectTitle, 'Studio Parity Film');
    assert.equal(createdProj.revision.length, 64);
    assert.ok(createdProj.sessionId);
    assert.equal(createdProj.exportJob, null);

    // 2. POST /motion-api/preview/open?projectId=<id> (MotionApp.tsx resolveWorkspaceProject)
    const previewOpenRes = await app.request(`/motion-api/preview/open?projectId=${createdProj.projectId}`, {
      method: 'POST',
    });
    assert.equal(previewOpenRes.status, 200);
    const previewOpen = (await previewOpenRes.json()) as {
      ok: boolean;
      activeId: string;
      artifact: { id: string; kind: string; projectId: string; title: string };
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.equal(previewOpen.ok, true);
    assert.equal(previewOpen.activeId, createdProj.projectId);
    assert.equal(previewOpen.projectId, createdProj.projectId);
    assert.equal(previewOpen.projectTitle, 'Studio Parity Film');
    assert.equal(previewOpen.revision, createdProj.revision);
    assert.equal(previewOpen.sessionId, createdProj.sessionId);
    assert.equal(previewOpen.exportJob, null);
    assert.notEqual(createdProj.artifactId, createdProj.projectId);
    assert.deepEqual(previewOpen.artifact, { id: createdProj.artifactId, kind: 'motion-project',
      projectId: createdProj.projectId, title: 'Studio Parity Film' });

    // 3. GET /motion-api/project/status & POST /motion-api/projects/:id/open top-level WorkspaceStatus
    const statusRes = await app.request(`/motion-api/project/status?projectId=${createdProj.projectId}`);
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as {
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.equal(statusBody.projectId, createdProj.projectId);
    assert.equal(statusBody.projectTitle, 'Studio Parity Film');
    assert.equal(statusBody.revision, createdProj.revision);
    assert.equal(statusBody.sessionId, createdProj.sessionId);
    assert.equal(statusBody.exportJob, null);

    const load = t.mock.method(services.files, 'loadVirtualProject');
    const list = t.mock.method(services.workspace, 'getCatalog');
    const summary = await app.request(`/motion-api/project/status?view=summary&projectId=${createdProj.projectId}`);
    assert.equal(summary.status, 200);
    assert.deepEqual(await summary.json(), {
      projectId: statusBody.projectId, projectTitle: statusBody.projectTitle,
      sessionId: statusBody.sessionId, revision: statusBody.revision, exportJob: null,
    });
    assert.equal(load.mock.callCount(), 0);
    assert.equal(list.mock.callCount(), 0);

    const openProjRes = await app.request(`/motion-api/projects/${createdProj.projectId}/open`, { method: 'POST' });
    assert.equal(openProjRes.status, 200);
    const openProjBody = (await openProjRes.json()) as {
      ok: boolean;
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.equal(openProjBody.ok, true);
    assert.equal(openProjBody.projectId, createdProj.projectId);
    assert.equal(openProjBody.projectTitle, 'Studio Parity Film');
    assert.equal(openProjBody.revision, createdProj.revision);
    assert.equal(openProjBody.sessionId, createdProj.sessionId);
    assert.equal(openProjBody.exportJob, null);

    // 4. PATCH /motion-api/projects/:id returns full ProjectCatalog alongside mutation fields
    const renameProjRes = await app.request(`/motion-api/projects/${createdProj.projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed Studio Film' }),
    });
    assert.equal(renameProjRes.status, 200);
    const renameProjBody = (await renameProjRes.json()) as {
      projectId: string;
      title: string;
      activeId: string;
      projects: Array<{ id: string; title: string }>;
      sessions: Array<{ id: string }>;
    };
    assert.equal(renameProjBody.projectId, createdProj.projectId);
    assert.equal(renameProjBody.title, 'Renamed Studio Film');
    assert.ok(Array.isArray(renameProjBody.projects));
    assert.ok(renameProjBody.projects.some((p) => p.id === createdProj.projectId && p.title === 'Renamed Studio Film'));
    assert.ok(Array.isArray(renameProjBody.sessions));

    // 5. POST /motion-api/sessions (instruction + caller id), /artifacts, /open, /messages, PATCH session
    const callerSessionId = randomUUID();
    const createSessRes = await app.request('/motion-api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: callerSessionId, title: 'Pitch Deck', instruction: 'Make a 10s teaser' }),
    });
    assert.equal(createSessRes.status, 201);
    const createdSess = (await createSessRes.json()) as {
      sessionId: string;
      session: { id: string; messages: Array<{ content: string }> };
    };
    assert.equal(createdSess.sessionId, callerSessionId);
    assert.equal(createdSess.session.id, callerSessionId);
    assert.equal(createdSess.session.messages[0]?.content, 'Make a 10s teaser');

    const artifactRes = await app.request(`/motion-api/sessions/${callerSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Teaser Cut 1' }),
    });
    assert.equal(artifactRes.status, 201);
    const artifactBody = (await artifactRes.json()) as {
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.ok(artifactBody.projectId);
    assert.equal(artifactBody.projectTitle, 'Teaser Cut 1');
    assert.equal(artifactBody.sessionId, callerSessionId);
    assert.equal(artifactBody.exportJob, null);

    const openSessRes = await app.request(`/motion-api/sessions/${callerSessionId}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: artifactBody.projectId }),
    });
    assert.equal(openSessRes.status, 200);
    const openSessBody = (await openSessRes.json()) as {
      ok: boolean;
      sessionId: string;
      projectId: string;
      projectTitle: string;
      revision: string;
      exportJob: unknown;
    };
    assert.equal(openSessBody.ok, true);
    assert.equal(openSessBody.sessionId, callerSessionId);
    assert.equal(openSessBody.projectId, artifactBody.projectId);
    assert.equal(openSessBody.projectTitle, 'Teaser Cut 1');
    assert.equal(openSessBody.revision, artifactBody.revision);
    assert.equal(openSessBody.exportJob, null);

    const renameSessRes = await app.request(`/motion-api/sessions/${callerSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pitch Deck Final' }),
    });
    assert.equal(renameSessRes.status, 200);
    const renameSessBody = (await renameSessRes.json()) as {
      id: string;
      projects: unknown[];
      sessions: Array<{ id: string; title: string }>;
    };
    assert.equal(renameSessBody.id, callerSessionId);
    assert.ok(Array.isArray(renameSessBody.projects));
    assert.ok(renameSessBody.sessions.some((s) => s.id === callerSessionId && s.title === 'Pitch Deck Final'));

    const msgRes = await app.request(`/motion-api/sessions/${callerSessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), content: 'Tighten pacing' }),
    });
    assert.equal(msgRes.status, 201);
    const msgBody = (await msgRes.json()) as { id: string; artifacts: unknown[]; messages: unknown[] };
    assert.equal(msgBody.id, callerSessionId);
    assert.ok(Array.isArray(msgBody.artifacts));
    assert.equal(msgBody.messages.length, 2);

    // 6. POST /motion-api/templates/:id/open accepts expectedRevision & expectedProjectId without 400
    const tplOpenRes = await app.request('/motion-api/templates/studio-smoke-tpl/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: createdProj.revision,
        expectedProjectId: createdProj.projectId,
      }),
    });
    assert.equal(tplOpenRes.status, 201);
    const tplOpenBody = (await tplOpenRes.json()) as {
      projectId: string;
      projectTitle: string;
      revision: string;
      sessionId: string;
      exportJob: unknown;
    };
    assert.ok(tplOpenBody.projectId);
    assert.equal(tplOpenBody.projectTitle, 'Smoke Template');
    assert.equal(tplOpenBody.revision.length, 64);
    assert.ok(tplOpenBody.sessionId);
    assert.equal(tplOpenBody.exportJob, null);

    // 6b. Studio startSession + /sessions/:id/artifacts clones editable templates zero-copy
    //     (both via inherited session.templateId and explicit body.templateId) and falls back
    //     to a blank project for reference-only templates without index.html.
    pgClient.seed('catalog_templates', {
      id: 'studio-ref-only-tpl',
      kind: 'prism',
      catalog_version: 'v1',
      sort_order: 2,
      featured_order: null,
      has_html_project: false,
      metadata: { title: 'Reference Only Template', category: 'featured', durationSec: 5 },
      instructions_md: null,
      motion_md: null,
      updated_at: new Date().toISOString(),
    });

    const tplSessionId = randomUUID();
    const tplSessRes = await app.request('/motion-api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tplSessionId, mode: 'motion', templateId: 'studio-smoke-tpl' }),
    });
    assert.equal(tplSessRes.status, 201);
    const tplSessBody = (await tplSessRes.json()) as { sessionId: string; title: string };
    assert.equal(tplSessBody.sessionId, tplSessionId);
    assert.equal(tplSessBody.title, 'Smoke Template');

    // First artifact without repeating templateId inherits session.templateId and clones zero-copy.
    const inheritedArtifactRes = await app.request(`/motion-api/sessions/${tplSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: createdProj.revision, expectedProjectId: createdProj.projectId }),
    });
    assert.equal(inheritedArtifactRes.status, 201);
    const inheritedArtifact = (await inheritedArtifactRes.json()) as {
      projectId: string;
      projectTitle: string;
      templateId: string;
      fileCount: number;
    };
    assert.equal(inheritedArtifact.templateId, 'studio-smoke-tpl');
    assert.equal(inheritedArtifact.projectTitle, 'Smoke Template');
    assert.equal(inheritedArtifact.fileCount, 1);
    const inheritedIndexRes = await app.request(`/api/projects/${inheritedArtifact.projectId}/files/index.html`);
    assert.equal(inheritedIndexRes.status, 200);
    assert.equal(
      ((await inheritedIndexRes.json()) as { content: string }).content,
      '<div data-composition-id="main">Template</div>',
    );

    // Subsequent artifact with explicit templateId (Studio createArtifact / templateHandoff flow).
    const explicitArtifactRes = await app.request(`/motion-api/sessions/${tplSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'studio-smoke-tpl', title: 'Custom Template Copy' }),
    });
    assert.equal(explicitArtifactRes.status, 201);
    const explicitArtifact = (await explicitArtifactRes.json()) as {
      projectId: string;
      projectTitle: string;
      templateId: string;
    };
    assert.equal(explicitArtifact.templateId, 'studio-smoke-tpl');
    assert.equal(explicitArtifact.projectTitle, 'Custom Template Copy');
    const explicitIndexRes = await app.request(`/api/projects/${explicitArtifact.projectId}/files/index.html`);
    assert.equal(explicitIndexRes.status, 200);
    assert.equal(
      ((await explicitIndexRes.json()) as { content: string }).content,
      '<div data-composition-id="main">Template</div>',
    );

    // Reference-only template falls back cleanly to a blank project inside the session.
    const refArtifactRes = await app.request(`/motion-api/sessions/${tplSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'studio-ref-only-tpl', title: 'Ref Recreation' }),
    });
    assert.equal(refArtifactRes.status, 201);
    const refArtifact = (await refArtifactRes.json()) as { projectId: string; projectTitle: string };
    assert.ok(refArtifact.projectId);
    assert.equal(refArtifact.projectTitle, 'Ref Recreation');

    // POST /motion-api/projects with editable templateId also clones zero-copy.
    const projFromTplRes = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'studio-smoke-tpl', title: 'Direct Project Clone' }),
    });
    assert.equal(projFromTplRes.status, 201);
    const projFromTpl = (await projFromTplRes.json()) as {
      projectId: string;
      projectTitle: string;
      templateId: string;
    };
    assert.equal(projFromTpl.templateId, 'studio-smoke-tpl');
    assert.equal(projFromTpl.projectTitle, 'Direct Project Clone');
    const projFromTplIndex = await app.request(`/api/projects/${projFromTpl.projectId}/files/index.html`);
    assert.equal(projFromTplIndex.status, 200);
    assert.equal(
      ((await projFromTplIndex.json()) as { content: string }).content,
      '<div data-composition-id="main">Template</div>',
    );

    // Zero-artifact session with a removed/missing inherited templateId falls back cleanly to a blank project,
    // while an explicit missing templateId on the request still fails with 404.
    const goneSessionId = randomUUID();
    const goneSessRes = await app.request('/motion-api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: goneSessionId, mode: 'motion', templateId: 'removed-catalog-tpl' }),
    });
    assert.equal(goneSessRes.status, 201);
    const goneInheritedRes = await app.request(`/motion-api/sessions/${goneSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(goneInheritedRes.status, 201);
    const goneInherited = (await goneInheritedRes.json()) as { projectId: string };
    assert.ok(goneInherited.projectId);

    const explicitMissingRes = await app.request(`/motion-api/sessions/${goneSessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'removed-catalog-tpl' }),
    });
    assert.equal(explicitMissingRes.status, 404);

    // Shared capability parity: MCP openmotion_create_project with { templateId } (even with projectType=natural_language)
    // also clones zero-copy via the same createOrCloneProject service, and falls back for reference-only templates.
    const mcpCloneCall = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_create_project',
        arguments: {
          projectType: 'natural_language',
          title: 'MCP Shared Clone',
          requirements: 'Use the smoke template as a starting point',
          templateId: 'studio-smoke-tpl',
          requestId: 'req-mcp-shared-clone',
        },
      }),
    });
    assert.equal(mcpCloneCall.status, 200);
    const mcpCloneBody = (await mcpCloneCall.json()) as { projectId: string; templateId: string };
    assert.equal(mcpCloneBody.templateId, 'studio-smoke-tpl');
    const mcpCloneIndex = await app.request(`/api/projects/${mcpCloneBody.projectId}/files/index.html`);
    assert.equal(mcpCloneIndex.status, 200);
    assert.equal(
      ((await mcpCloneIndex.json()) as { content: string }).content,
      '<div data-composition-id="main">Template</div>',
    );

    const mcpRefFallbackCall = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_create_project',
        arguments: {
          projectType: 'natural_language',
          title: 'MCP Ref Fallback',
          requirements: 'Recreate from reference template',
          templateId: 'studio-ref-only-tpl',
          requestId: 'req-mcp-ref-fallback',
        },
      }),
    });
    assert.equal(mcpRefFallbackCall.status, 200);
    const mcpRefFallbackBody = (await mcpRefFallbackCall.json()) as { projectId: string };
    assert.ok(mcpRefFallbackBody.projectId);

    // 7. POST /motion-api/phase1/call (openmotion_get_project currentVersionId, openmotion_assets_use, P2 501)
    const getProjCall = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_get_project',
        arguments: { projectId: createdProj.projectId },
      }),
    });
    assert.equal(getProjCall.status, 200);
    const getProjBody = (await getProjCall.json()) as {
      projectId: string;
      revision: string;
      currentVersionId: string;
      version: { versionId: string };
    };
    assert.equal(getProjBody.projectId, createdProj.projectId);
    assert.equal(getProjBody.revision, createdProj.revision);
    assert.ok(getProjBody.currentVersionId);
    assert.equal(getProjBody.currentVersionId, getProjBody.version.versionId);

    const assetsListCall = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_assets_use',
        arguments: { action: 'list', sort: 'newest', offset: 0, limit: 40 },
      }),
    });
    assert.equal(assetsListCall.status, 200);
    const assetsListBody = (await assetsListCall.json()) as { assets: unknown[]; total: number };
    assert.deepEqual(assetsListBody.assets, []);
    assert.equal(assetsListBody.total, 0);

    const p2Call = await app.request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'openmotion_manage_project',
        arguments: { action: 'comments', projectId: createdProj.projectId },
      }),
    });
    assert.equal(p2Call.status, 501);
    const p2Body = (await p2Call.json()) as { code: string; error: string };
    assert.equal(p2Body.code, 'FEATURE_DEFERRED_P2');
    assert.equal(typeof p2Body.error, 'string');

    // 8. GET /motion-api/generations + POST /motion-api/generations/:id/cancel (GenerationJob shape)
    const submitGenRes = await app.request('/motion-api/models/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modality: 'image',
        model: 'opendesign:mock-image-1',
        prompt: 'Golden hour mountain silhouette',
        projectId: createdProj.projectId,
        requestId: 'req-gen-studio-1',
      }),
    });
    assert.equal(submitGenRes.status, 202);
    const submittedGen = (await submitGenRes.json()) as {
      job: { id: string; model: { label: string }; createdAt: number; updatedAt: number; assets: unknown[]; saveToLibrary: boolean };
    };
    assert.equal(typeof submittedGen.job.createdAt, 'number');
    assert.equal(typeof submittedGen.job.updatedAt, 'number');
    assert.equal(typeof submittedGen.job.model.label, 'string');
    assert.ok(Array.isArray(submittedGen.job.assets));
    assert.equal(submittedGen.job.saveToLibrary, true);

    const gensRes = await app.request(`/motion-api/generations?projectId=${createdProj.projectId}`);
    assert.equal(gensRes.status, 200);
    const gensBody = (await gensRes.json()) as { jobs: Array<{ id: string }> };
    assert.equal(gensBody.jobs.length, 1);
    assert.equal(gensBody.jobs[0].id, submittedGen.job.id);

    const cancelGenRes = await app.request(`/motion-api/generations/${submittedGen.job.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(cancelGenRes.status, 200);
    const cancelGenBody = (await cancelGenRes.json()) as { job: { id: string; state: string } };
    assert.equal(cancelGenBody.job.id, submittedGen.job.id);
    assert.equal(cancelGenBody.job.state, 'cancelled');

    // 9. GET/PUT/POST /motion-api/tracking/preferences & GET /motion-api/health
    for (const method of ['GET', 'PUT', 'POST'] as const) {
      const prefRes = await app.request('/motion-api/tracking/preferences', {
        method,
        ...(method !== 'GET'
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }
          : {}),
      });
      assert.equal(prefRes.status, 200, `expected 200 for ${method} /motion-api/tracking/preferences`);
      const prefBody = (await prefRes.json()) as { enabled: boolean; preference: boolean; locked: boolean };
      assert.equal(prefBody.enabled, false);
      assert.equal(prefBody.preference, false);
      assert.equal(prefBody.locked, true);
    }

    const motionHealthRes = await app.request('/motion-api/health');
    assert.equal(motionHealthRes.status, 200);
    assert.ok(((await motionHealthRes.json()) as { version?: string }).version);
  });
});

// ---------------------------------------------------------------------------
// 7. Comment c5 — Cookie-less Preview Subdomain Isolation & Unified Config
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Unified Config & Cookie-less Preview Subdomain Isolation (c5)', () => {
  it('validates c1/c2/c3/c4/c5 config defaults, trimming, bounds, and S3 CORS origin inclusion', () => {
    const defaults = makeConfig();
    assert.equal(defaults.BLOB_GC_GRACE_SECONDS, 604_800);
    assert.equal(defaults.S3_PRESIGN_CACHE_WINDOW_SEC, 3600);
    assert.equal(defaults.PREVIEW_PUBLIC_ORIGIN, undefined);
    assert.equal(defaults.PREVIEW_TOKEN_TTL_SEC, 900);
    assert.equal(defaults.HISTORY_COALESCE_WINDOW_MS, 4000);
    assert.deepEqual(resolveApiCorsAllowedOrigins(defaults), ['https://motion.example.test']);

    const configured = makeConfig({
      PREVIEW_PUBLIC_ORIGIN: '  https://preview.openmotion.test  ',
      PREVIEW_TOKEN_TTL_SEC: '600',
      S3_PRESIGN_CACHE_WINDOW_SEC: '1800',
      HISTORY_COALESCE_WINDOW_MS: '0',
    });
    assert.equal(configured.PREVIEW_PUBLIC_ORIGIN, 'https://preview.openmotion.test');
    assert.equal(configured.PREVIEW_TOKEN_TTL_SEC, 600);
    assert.equal(configured.S3_PRESIGN_CACHE_WINDOW_SEC, 1800);
    assert.equal(configured.HISTORY_COALESCE_WINDOW_MS, 0);
    assert.deepEqual(resolveApiCorsAllowedOrigins(configured), [
      'https://motion.example.test',
      'https://preview.openmotion.test',
    ]);

    assert.throws(() => makeConfig({ S3_PRESIGN_CACHE_WINDOW_SEC: '0' }), /INVALID_CONFIG/);
    assert.throws(() => makeConfig({ PREVIEW_TOKEN_TTL_SEC: '0' }), /INVALID_CONFIG/);
    assert.throws(() => makeConfig({ PREVIEW_PUBLIC_ORIGIN: 'not-a-url' }), /INVALID_CONFIG/);
    assert.throws(() => makeConfig({ HISTORY_COALESCE_WINDOW_MS: '-1' }), /INVALID_CONFIG/);
  });

  it('enforces strict preview host isolation (403 PREVIEW_ORIGIN_ISOLATED), ignores cookies, and validates scoped preview tokens', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const fixture = createApiFixture({
      config: {
        AUTH_MODE: 'oidc',
        APP_PUBLIC_ORIGIN: 'https://motion.example.test',
        PREVIEW_PUBLIC_ORIGIN: 'https://preview.openmotion.test',
        PREVIEW_TOKEN_TTL_SEC: '900',
        TRUST_PROXY_HOPS: '1',
      },
    });
    const { app, config, authStore, pgClient } = fixture;

    const userId = randomUUID();
    const workspaceId = randomUUID();
    authStore.seedWorkspace({
      workspaceId,
      userId,
      oidcSub: 'oidc-preview-isolation-1',
      email: 'preview@example.test',
      displayName: 'Preview Creator',
      role: 'owner',
      slug: 'preview-ws',
      name: 'Preview Workspace',
    });
    pgClient.seed('workspaces', {
      id: workspaceId,
      slug: 'preview-ws',
      name: 'Preview Workspace',
      owner_user_id: userId,
      active_project_id: null,
      default_models: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const browserSession = await createBrowserSession(authStore, { userId, workspaceId });
    const cookieHeader = `${SESSION_COOKIE_NAME}=${browserSession.token}`;
    const mainMutateHeaders = {
      Cookie: cookieHeader,
      Origin: 'https://motion.example.test',
      'Content-Type': 'application/json',
    };

    // /__hyperframes_config exposes previewOrigin on main host
    const cfgRes = await app.request('/__hyperframes_config');
    assert.equal(cfgRes.status, 200);
    const cfgBody = (await cfgRes.json()) as { previewOrigin: string | null };
    assert.equal(cfgBody.previewOrigin, 'https://preview.openmotion.test');

    // Create two projects on the main origin
    const createA = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: mainMutateHeaders,
      body: JSON.stringify({ title: 'Project Alpha' }),
    });
    assert.equal(createA.status, 201);
    const projectA = ((await createA.json()) as { projectId: string }).projectId;

    const createB = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: mainMutateHeaders,
      body: JSON.stringify({ title: 'Project Beta' }),
    });
    assert.equal(createB.status, 201);
    const projectB = ((await createB.json()) as { projectId: string }).projectId;

    // Mint a project-scoped preview token on the main origin
    const tokenRes = await app.request(`/api/projects/${projectA}/preview-token`, {
      method: 'POST',
      headers: mainMutateHeaders,
    });
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.headers.get('cache-control'), 'no-store');
    const minted = (await tokenRes.json()) as {
      token: string;
      expiresAt: string;
      previewOrigin: string | null;
      previewUrl: string;
    };
    assert.equal(minted.previewOrigin, 'https://preview.openmotion.test');
    assert.ok(minted.previewUrl.startsWith(`https://preview.openmotion.test/api/projects/${projectA}/preview?pt=`));
    assert.ok(Date.parse(minted.expiresAt) > Date.now());

    // Unit-check token payload verification directly
    const secret = resolvePreviewTokenSecret(config);
    const decoded = verifyPreviewToken(minted.token, secret, { expectedProjectId: projectA });
    assert.ok(decoded);
    assert.equal(decoded.typ, 'om_preview');
    assert.equal(decoded.wid, workspaceId);
    assert.equal(decoded.pid, projectA);
    assert.equal(verifyPreviewToken(minted.token, secret, { expectedProjectId: projectB }), null);

    // 1. Preview host IMMEDIATELY REJECTS /motion-api/*, /auth/*, /oauth/*, /mcp, files, preview-token & mutations with 403 PREVIEW_ORIGIN_ISOLATED
    const blockedRequests: Array<{ method: string; path: string; hostHeader: Record<string, string> }> = [
      { method: 'GET', path: '/motion-api/projects', hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'GET', path: '/auth/me', hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'POST', path: '/oauth/token', hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'POST', path: '/mcp', hostHeader: { 'X-Forwarded-Host': 'preview.openmotion.test' } },
      { method: 'GET', path: `/api/projects/${projectA}/files/index.html`, hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'POST', path: `/api/projects/${projectA}/preview-token`, hostHeader: { Host: 'preview.openmotion.test' } },
      { method: 'DELETE', path: `/api/projects/${projectA}/preview`, hostHeader: { Host: 'preview.openmotion.test' } },
    ];
    for (const entry of blockedRequests) {
      const res = await app.request(entry.path, {
        method: entry.method,
        headers: {
          ...entry.hostHeader,
          Cookie: cookieHeader,
        },
      });
      assert.equal(res.status, 403, `expected 403 on preview host for ${entry.method} ${entry.path}`);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'PREVIEW_ORIGIN_ISOLATED');
      assert.equal(
        res.headers.get('content-security-policy'),
        "frame-ancestors 'self' https://motion.example.test;",
      );
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('set-cookie'), null);
    }

    // 2. Preview host IGNORES browser session cookies on /api/projects/:id/preview (requires scoped preview token!)
    const cookieOnlyPreview = await app.request(`/api/projects/${projectA}/preview`, {
      headers: {
        Host: 'preview.openmotion.test',
        Cookie: cookieHeader,
      },
    });
    assert.equal(cookieOnlyPreview.status, 401);

    // 3. Valid scoped preview token via ?pt=... AND X-OpenMotion-Preview-Token succeeds on preview host with security headers
    const viaQuery = await app.request(
      `/api/projects/${projectA}/preview?pt=${encodeURIComponent(minted.token)}`,
      { headers: { Host: 'preview.openmotion.test' } },
    );
    assert.equal(viaQuery.status, 200);
    assert.equal(
      viaQuery.headers.get('content-security-policy'),
      "frame-ancestors 'self' https://motion.example.test;",
    );
    assert.equal(viaQuery.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(viaQuery.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(viaQuery.headers.get('set-cookie'), null);
    const previewHtml = await viaQuery.text();
    assert.match(previewHtml, /Project Alpha/);
    const base = previewHtml.match(/<base href="([^"]+)"/)?.[1];
    assert.ok(base);
    const assetUrl = new URL('index.html', base);
    assert.equal(assetUrl.origin, minted.previewOrigin);
    const previewHeaders = { Host: assetUrl.host };
    const assetResponse = await app.request(assetUrl.href, { headers: previewHeaders });
    assert.equal(assetResponse.status, 200);
    assert.match(await assetResponse.text(), /Project Alpha/);
    const assetHead = await app.request(assetUrl.href, { method: 'HEAD', headers: previewHeaders });
    assert.equal(assetHead.status, 200);
    assert.equal(await assetHead.text(), '');
    const foreignAsset = await app.request(assetUrl.href.replace(projectA, projectB), { headers: previewHeaders });
    assert.equal(foreignAsset.status, 401);
    const sameOriginHtml = await app.request(`/api/projects/${projectA}/preview`, {
      headers: { Cookie: cookieHeader },
    });
    assert.ok(!(await sameOriginHtml.text()).includes('~assets/'));
    assert.match(sameOriginHtml.headers.get('content-security-policy') ?? '', /sandbox/);
    const mainAsset = await app.request(`/api/projects/${projectA}/preview/index.html`, {
      headers: { Cookie: cookieHeader },
    });
    assert.match(mainAsset.headers.get('content-security-policy') ?? '', /script-src 'none'/);
    const nav = (path: string, site: string) => app.request(path, {
      headers: { Cookie: cookieHeader, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': site },
    });
    const documentPath = `/api/projects/${projectA}/preview/comp/index.html?capture=1`;
    const mainNavigation = await nav(documentPath, 'same-origin');
    assert.equal(mainNavigation.status, 302);
    const isolatedLocation = new URL(mainNavigation.headers.get('location')!);
    assert.equal(isolatedLocation.origin, minted.previewOrigin);
    assert.equal(isolatedLocation.searchParams.get('capture'), '1');
    assert.ok(verifyPreviewToken(isolatedLocation.searchParams.get('pt'), secret, { expectedProjectId: projectA }));
    assert.equal((await nav(documentPath, 'same-site')).status, 403);
    assert.equal((await nav(documentPath, 'cross-site')).status, 403);

    const viaHeader = await app.request(`/api/projects/${projectA}/preview`, {
      headers: {
        'X-Forwarded-Host': 'preview.openmotion.test',
        'X-OpenMotion-Preview-Token': minted.token,
      },
    });
    assert.equal(viaHeader.status, 200);

    // 4. Cross-project preview token is rejected (401)
    const crossProject = await app.request(
      `/api/projects/${projectB}/preview?pt=${encodeURIComponent(minted.token)}`,
      { headers: { Host: 'preview.openmotion.test' } },
    );
    assert.equal(crossProject.status, 401);

    // 5. Expired preview token is rejected (401)
    const expired = signPreviewToken(
      { workspaceId, projectId: projectA, ttlSec: 60, nowMs: Date.now() - 120_000 },
      secret,
    );
    const expiredRes = await app.request(
      `/api/projects/${projectA}/preview?pt=${encodeURIComponent(expired.token)}`,
      { headers: { Host: 'preview.openmotion.test' } },
    );
    assert.equal(expiredRes.status, 401);
    const expiredAsset = await app.request(assetUrl.href.replace(minted.token, expired.token), { headers: previewHeaders });
    assert.equal(expiredAsset.status, 401);

    // A live Studio session renews asset URLs without replacing the loaded document.
    const leaseRequest = async (id: string, assetLease: true | string) => {
      const response = await app.request(`/api/projects/${id}/preview-token`, {
        method: 'POST', headers: mainMutateHeaders, body: JSON.stringify({ assetLease }),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ token: string; assetLease: string; previewUrl: string }>;
    };
    const initial = await leaseRequest(projectA, true);
    const leaseDocument = await app.request(initial.previewUrl, { headers: previewHeaders });
    const leaseBase = (await leaseDocument.text()).match(/<base href="([^"]+)"/)?.[1];
    assert.ok(leaseBase?.includes(initial.assetLease));
    const secondLease = await leaseRequest(projectA, true);
    const otherDocument = await app.request(secondLease.previewUrl, {
      headers: { ...previewHeaders, 'If-None-Match': leaseDocument.headers.get('etag')! },
    });
    assert.equal(otherDocument.status, 200);
    const otherHtml = await otherDocument.text();
    assert.ok(otherHtml.includes(secondLease.assetLease));
    assert.ok(!otherHtml.includes(initial.assetLease));
    assert.notEqual(otherDocument.headers.get('etag'), leaseDocument.headers.get('etag'));
    const leaseAssetUrl = new URL('index.html', leaseBase);
    assert.equal((await app.request(leaseAssetUrl.href, { headers: previewHeaders })).status, 200);
    const foreignLease = await leaseRequest(projectB, initial.assetLease);
    assert.notEqual(foreignLease.assetLease, initial.assetLease);
    assert.equal((await app.request(leaseAssetUrl.href.replace(projectA, projectB), { headers: previewHeaders })).status, 401);
    assert.equal((await app.request(initial.previewUrl.replace(initial.token, initial.assetLease), { headers: previewHeaders })).status, 401);
    t.mock.timers.tick(600_000);
    const renewed = await leaseRequest(projectA, initial.assetLease);
    assert.equal(renewed.assetLease, initial.assetLease);
    t.mock.timers.tick(301_000);
    assert.equal((await app.request(initial.previewUrl, { headers: previewHeaders })).status, 401);
    assert.equal((await app.request(leaseAssetUrl.href, { headers: previewHeaders })).status, 200);
    t.mock.timers.tick(600_000);
    assert.equal((await app.request(leaseAssetUrl.href, { headers: previewHeaders })).status, 401);
    assert.notEqual((await leaseRequest(projectA, initial.assetLease)).assetLease, initial.assetLease);

    // 6. Preview token is NEVER accepted as a Bearer token on main-origin /motion-api/* or /mcp
    const mainApiWithPreviewToken = await app.request('/motion-api/projects', {
      headers: { Authorization: `Bearer ${minted.token}` },
    });
    assert.equal(mainApiWithPreviewToken.status, 401);

    const mcpWithPreviewToken = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcpWithPreviewToken.status, 401);

    // 7. Read-only runtime/vendor/fonts/health/OPTIONS routes remain reachable on the preview host
    for (const allowedPath of [
      '/api/runtime.js',
      '/api/vendor/gsap/gsap.min.js',
      '/api/vendor/gsap/gsap@3.15.0/dist/MotionPathPlugin.min.js',
      '/api/fonts',
      '/api/health/live',
    ]) {
      const res = await app.request(allowedPath, {
        headers: { Host: 'preview.openmotion.test' },
      });
      assert.equal(res.status, 200, `expected 200 on preview host for ${allowedPath}`);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }

    const optRes = await app.request(`/api/projects/${projectA}/preview`, {
      method: 'OPTIONS',
      headers: {
        Host: 'preview.openmotion.test',
        Origin: 'https://motion.example.test',
      },
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), 'https://motion.example.test');
    assert.equal(optRes.headers.get('access-control-allow-credentials'), null);

    // 8. Even in AUTH_MODE=dev, preview host never falls back to dev_bypass without a valid preview token
    const devIsolated = createApiFixture({
      config: {
        AUTH_MODE: 'dev',
        APP_PUBLIC_ORIGIN: 'https://motion.example.test',
        PREVIEW_PUBLIC_ORIGIN: 'https://preview.openmotion.test',
      },
    });
    const devProjRes = await devIsolated.app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Dev Isolated' }),
    });
    const devProjId = ((await devProjRes.json()) as { projectId: string }).projectId;
    const devUnauthPreview = await devIsolated.app.request(`/api/projects/${devProjId}/preview`, {
      headers: { Host: 'preview.openmotion.test' },
    });
    assert.equal(devUnauthPreview.status, 401);

    // 9. When PREVIEW_PUBLIC_ORIGIN is unset (local Compose dev), /__hyperframes_config reports previewOrigin: null and single-host preview works seamlessly
    const localDev = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const localCfg = (await (await localDev.app.request('/__hyperframes_config')).json()) as {
      previewOrigin: string | null;
    };
    assert.equal(localCfg.previewOrigin, null);
    const localProjId = (
      (await (
        await localDev.app.request('/motion-api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Single Host Local' }),
        })
      ).json()) as { projectId: string }
    ).projectId;
    const localPreview = await localDev.app.request(`/api/projects/${localProjId}/preview`);
    assert.equal(localPreview.status, 200);
  });
});

// ---------------------------------------------------------------------------
// 8. OAuth Agent Project Grant Enforcement on MCP Asset Import & Media Jobs
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — OAuth Agent Project Grants (Import Assets & Media Jobs)', () => {
  it('enforces project_grants across openmotion_import_assets and all openmotion_media job operations', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const { app, config, pgClient, authStore } = fixture;

    // Seed workspace membership & OAuth bearer token for an external agent client
    const userId = config.DEV_USER_ID;
    const workspaceId = config.DEV_WORKSPACE_ID;
    const clientId = 'oauth-client-codex';
    authStore.seedWorkspace({
      userId,
      workspaceId,
      email: 'owner@example.test',
      displayName: 'Owner',
    });
    const rawAccessToken = `om_oat_${'a'.repeat(40)}`;
    const tokenHash = createHash('sha256').update(rawAccessToken).digest('hex');
    await authStore.createOAuthToken({
      clientId,
      userId,
      workspaceId,
      accessTokenHash: tokenHash,
      refreshTokenHash: null,
      scope: DEFAULT_PAT_SCOPES.join(' '),
      resource: `${config.APP_PUBLIC_ORIGIN}/mcp`,
      accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: null,
    });

    // Create two projects owned by the user via dev session: projectA (granted) and projectB (ungranted)
    const createProj = async (title: string): Promise<string> => {
      const res = await app.request('/motion-api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      assert.equal(res.status, 201);
      return ((await res.json()) as { projectId: string }).projectId;
    };
    const projectA = await createProj('Granted Project A');
    const projectB = await createProj('Ungranted Project B');

    // Grant projectA ONLY to `oauth-client-codex`
    pgClient.seed('project_grants', {
      id: randomUUID(),
      project_id: projectA,
      user_id: userId,
      workspace_id: workspaceId,
      client_id: clientId,
      granted_at: new Date().toISOString(),
      revoked_at: null,
    });

    const agent: AuthContext = {
      authMode: 'oidc', authMethod: 'oauth_bearer', role: 'editor', scopes: DEFAULT_PAT_SCOPES,
      clientId, userId, workspaceId,
    };
    const sessionA = pgClient.rows('projects').find(row => row.id === projectA)!.session_id as string;
    const sessionB = pgClient.rows('projects').find(row => row.id === projectB)!.session_id as string;
    const workspace = fixture.services.workspace;
    await assert.rejects(workspace.selectProject(agent, projectA, projectB), { code: 'PROJECT_GRANT_REQUIRED' });
    await assert.rejects(workspace.openSessionForEditor(agent, sessionA, projectA, projectB), { code: 'PROJECT_GRANT_REQUIRED' });
    await assert.rejects(workspace.openSessionForEditor(agent, sessionB, projectB, projectA), { code: 'PROJECT_GRANT_REQUIRED' });
    assert.equal((await workspace.openSessionForEditor(agent, sessionA, projectA, projectA)).projectId, projectA);

    // Initialize an MCP session authenticated as `oauth_bearer`
    const mcpHeaders = {
      Authorization: `Bearer ${rawAccessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const initRes = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'codex-grant-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const mcpSessionId = initRes.headers.get('mcp-session-id');
    assert.ok(mcpSessionId);

    const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { ...mcpHeaders, 'Mcp-Session-Id': mcpSessionId },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
          content?: Array<{ type: string; text?: string }>;
        };
      };
    };

    // 1. MCP openmotion_import_assets (prepare_upload & import) must reject ungranted projectB with PROJECT_GRANT_REQUIRED
    const prepUngranted = await callTool(2, 'openmotion_import_assets', {
      action: 'prepare_upload',
      projectId: projectB,
      requestId: 'req_prep_ungranted_1',
      files: [{ itemId: 'file-1', filename: 'hero.png', bytes: 1024, mimeType: 'image/png' }],
    });
    assert.equal(prepUngranted.result?.isError, true);
    assert.match(JSON.stringify(prepUngranted.result), /PROJECT_GRANT_REQUIRED/);

    const importUngranted = await callTool(3, 'openmotion_import_assets', {
      action: 'import',
      projectId: projectB,
      requestId: 'req_import_ungranted_1',
      items: [
        {
          itemId: 'item-1',
          source: { kind: 'url', url: 'https://93.184.216.34/sample.png' },
        },
      ],
    });
    assert.equal(importUngranted.result?.isError, true);
    assert.match(JSON.stringify(importUngranted.result), /PROJECT_GRANT_REQUIRED/);

    // Granted projectA succeeds on prepare_upload
    const prepGranted = await callTool(4, 'openmotion_import_assets', {
      action: 'prepare_upload',
      projectId: projectA,
      requestId: 'req_prep_granted_1',
      files: [{ itemId: 'file-1', filename: 'hero.png', bytes: 1024, mimeType: 'image/png' }],
    });
    assert.equal(prepGranted.result?.isError, undefined);

    // 2. Seed media_generate jobs on both projectA (granted) and projectB (ungranted)
    const jobAId = randomUUID();
    const jobBFailedId = randomUUID();
    const jobBSavePendingId = randomUUID();
    const jobASavePendingId = randomUUID();
    const nowIso = new Date().toISOString();

    pgClient.seed('jobs', {
      id: jobAId,
      workspace_id: workspaceId,
      project_id: projectA,
      kind: 'media_generate',
      state: 'failed',
      stage: 'failed',
      remote_id: 'upstream-remote-a',
      remote_terminal: false,
      save_pending: false,
      request_id: 'req_job_a',
      idempotency_key: 'req_job_a',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'mock', prompt: 'Granted prompt A' },
      created_at: nowIso,
      updated_at: nowIso,
    });
    pgClient.seed('jobs', {
      id: jobASavePendingId,
      workspace_id: workspaceId,
      project_id: projectA,
      kind: 'media_generate',
      state: 'completed',
      stage: 'completed',
      remote_id: null,
      remote_terminal: true,
      save_pending: true,
      request_id: 'req_job_a_save',
      idempotency_key: 'req_job_a_save',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'mock', prompt: 'Granted save A' },
      created_at: nowIso,
      updated_at: nowIso,
    });
    pgClient.seed('jobs', {
      id: jobBFailedId,
      workspace_id: workspaceId,
      project_id: projectB,
      kind: 'media_generate',
      state: 'failed',
      stage: 'failed',
      remote_id: 'upstream-remote-b',
      remote_terminal: false,
      save_pending: false,
      request_id: 'req_job_b',
      idempotency_key: 'req_job_b',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'mock', prompt: 'Secret prompt B' },
      created_at: nowIso,
      updated_at: nowIso,
    });
    pgClient.seed('jobs', {
      id: jobBSavePendingId,
      workspace_id: workspaceId,
      project_id: projectB,
      kind: 'media_generate',
      state: 'completed',
      stage: 'completed',
      remote_id: null,
      remote_terminal: true,
      save_pending: true,
      request_id: 'req_job_b_save',
      idempotency_key: 'req_job_b_save',
      input_payload: { modality: 'image', mode: 'text-to-image', modelId: 'mock', prompt: 'Secret save B' },
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 2a. listJobs without projectId (both MCP openmotion_assets_use and REST /motion-api/models/jobs)
    // must only return jobs from granted projectA (never projectB)
    const listAllRes = await callTool(5, 'openmotion_assets_use', { action: 'jobs' });
    assert.equal(listAllRes.result?.isError, undefined, JSON.stringify(listAllRes.result));
    const listedAll = (listAllRes.result?.structuredContent?.jobs ?? []) as Array<{ id: string; projectId: string }>;
    assert.equal(listedAll.length, 2);
    assert.ok(listedAll.every((j) => j.projectId === projectA));
    assert.doesNotMatch(JSON.stringify(listAllRes.result), /Secret prompt B|Secret save B/);

    const restListAll = await app.request('/motion-api/models/jobs', {
      headers: { Authorization: `Bearer ${rawAccessToken}` },
    });
    assert.equal(restListAll.status, 200);
    const restListAllBody = (await restListAll.json()) as { jobs: Array<{ id: string; projectId: string }> };
    assert.equal(restListAllBody.jobs.length, 2);
    assert.ok(restListAllBody.jobs.every((j) => j.projectId === projectA));

    // 2b. listJobs with non-UUID projectId must return empty (never fall back to workspace-wide list)
    const restListBadId = await app.request('/motion-api/models/jobs?projectId=not-a-uuid', {
      headers: { Authorization: `Bearer ${rawAccessToken}` },
    });
    assert.equal(restListBadId.status, 200);
    const restListBadBody = (await restListBadId.json()) as { jobs: Array<unknown> };
    assert.equal(restListBadBody.jobs.length, 0);

    // 2c. listJobs with ungranted projectId must reject with PROJECT_GRANT_REQUIRED
    const restListUngranted = await app.request(`/motion-api/models/jobs?projectId=${projectB}`, {
      headers: { Authorization: `Bearer ${rawAccessToken}` },
    });
    assert.equal(restListUngranted.status, 403);
    assert.match(await restListUngranted.text(), /PROJECT_GRANT_REQUIRED/);

    // 2d. resume on ungranted projectB job must reject with PROJECT_GRANT_REQUIRED
    const resumeUngranted = await callTool(8, 'openmotion_media_use', {
      action: 'resume',
      jobId: jobBFailedId,
      requestId: 'req_resume_b_1',
    });
    assert.equal(resumeUngranted.result?.isError, true);
    assert.match(JSON.stringify(resumeUngranted.result), /PROJECT_GRANT_REQUIRED/);

    // 2e. retry_save on ungranted projectB job must reject with PROJECT_GRANT_REQUIRED
    const retrySaveUngranted = await callTool(9, 'openmotion_media_use', {
      action: 'retry_save',
      jobId: jobBSavePendingId,
    });
    assert.equal(retrySaveUngranted.result?.isError, true);
    assert.match(JSON.stringify(retrySaveUngranted.result), /PROJECT_GRANT_REQUIRED/);

    // 2f. resume and retry_save on granted projectA jobs succeed
    const resumeGranted = await callTool(10, 'openmotion_media_use', {
      action: 'resume',
      jobId: jobAId,
      requestId: 'req_resume_a_1',
    });
    assert.equal(resumeGranted.result?.isError, undefined);

    const retrySaveGranted = await callTool(11, 'openmotion_media_use', {
      action: 'retry_save',
      jobId: jobASavePendingId,
    });
    assert.equal(retrySaveGranted.result?.isError, undefined);
  });
});
