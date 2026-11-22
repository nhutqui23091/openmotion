import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTracker, uuid } from './core.ts';
import type { Entry, Registry, PendingEvent, Receipt } from './core.ts';
import { unknownHost } from './host.ts';
import { unknownDevice } from './device.ts';
import type { DeviceIdentity } from './device.ts';

export type Identity = { installation_id: string; utm_source: string | null; created_at: string };
const sourcePattern = /^[A-Za-z0-9_.-]{1,64}$/;

export async function loadIdentity(directory: string, source?: string): Promise<Identity> {
  if (source !== undefined && (typeof source !== 'string' || !sourcePattern.test(source))) throw new Error('INVALID_SOURCE');
  const file = path.join(directory, 'identity.json');
  async function read(): Promise<Identity> {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (typeof value.installation_id !== 'string' || !uuid.test(value.installation_id)
      || (value.utm_source !== null && (typeof value.utm_source !== 'string' || !sourcePattern.test(value.utm_source)))
      || !Number.isFinite(Date.parse(value.created_at))) throw new Error('INVALID_IDENTITY');
    return value;
  }
  try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity: Identity = { installation_id: crypto.randomUUID(), utm_source: source ?? null, created_at: new Date().toISOString() };
  const temporary = file + '.' + crypto.randomUUID();
  try {
    await writeFile(temporary, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    // Publish a complete file exclusively; concurrent processes read the winning identity.
    try { await link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return await read();
  } finally { await rm(temporary, { force: true }); }
}

// Only an explicit installation updates attribution; ordinary startup retains it.
export async function saveInstallationSource(directory: string, source?: string): Promise<Identity> {
  const identity = await loadIdentity(directory, source);
  if (source === undefined || source === identity.utm_source) return identity;
  const updated = { ...identity, utm_source: source };
  const temporary = path.join(directory, 'identity.' + crypto.randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(updated), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(directory, 'identity.json'));
  } finally { await rm(temporary, { force: true }); }
  return updated;
}

export type PosthogEndpoint = {
  url: URL;
  token: string;
  geoip: boolean;
  env: 'development' | 'test' | 'production';
  testRunId?: string;
};

export function parsePosthogEndpoint(options: {
  host: string;
  token: string;
  env: string;
  testRunId?: string;
  geoip?: boolean;
}): PosthogEndpoint {
  if (options.env !== 'development' && options.env !== 'test' && options.env !== 'production') {
    throw new Error('INVALID_TRACKING_ENV');
  }
  const url = new URL(options.host);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_INGEST_HOST');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('INVALID_INGEST_HOST');
  if (!/^phc_[A-Za-z0-9_]+$/.test(options.token)) throw new Error('PUBLIC_PROJECT_TOKEN_REQUIRED');
  if (options.testRunId && (!uuid.test(options.testRunId) || options.env !== 'test')) throw new Error('INVALID_TEST_RUN');
  return {
    url,
    token: options.token,
    geoip: Boolean(options.geoip),
    env: options.env,
    ...(options.testRunId ? { testRunId: options.testRunId } : {}),
  };
}

export function posthogCommonProperties(options: {
  endpoint: PosthogEndpoint;
  identity: Identity;
  device: DeviceIdentity;
  appVersion: string;
  source: string | null;
  eventId: string;
  occurredAt: string;
  entrypoint: Entry;
  hostContext?: Record<string, unknown>;
  deviceTimezone: string | null;
  utcOffsetMinutes: number;
}) {
  const { endpoint, identity, device, appVersion, source, eventId, occurredAt, entrypoint, hostContext, deviceTimezone, utcOffsetMinutes } = options;
  return {
    event_schema_version: 1,
    schema_version: 1,
    product: 'openmotion',
    ...(hostContext ?? unknownHost),
    app_version: appVersion,
    env: endpoint.env,
    channel: 'standalone',
    ...(endpoint.testRunId ? { test_run_id: endpoint.testRunId } : {}),
    event_id: eventId,
    $insert_id: eventId,
    occurred_at: occurredAt,
    installation_id: identity.installation_id,
    ...device,
    distinct_id: identity.installation_id,
    utm_source: source,
    od_utm_source: source,
    entrypoint,
    runtime: entrypoint === 'studio' ? 'browser' : 'node',
    capture_source: 'explicit',
    client_type: entrypoint === 'studio' ? 'web' : 'local',
    platform: os.platform(),
    arch: os.arch(),
    $os: os.type(),
    $os_version: os.release(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    device_timezone: deviceTimezone,
    utc_offset_minutes: utcOffsetMinutes,
    // GeoIP requires an ingress that discards IP after enrichment; custom collectors default to zero-IP mode.
    ...(endpoint.geoip
      ? { location_source: 'geoip', $geoip_disable: false }
      : { location_source: 'unknown', $geoip_disable: true, $ip: '0.0.0.0' }),
    $process_person_profile: false,
  };
}

export async function postPosthogBatch(options: {
  endpoint: PosthogEndpoint;
  batch: readonly unknown[];
  signal: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  isEnabled?: () => boolean;
}): Promise<Receipt> {
  if (options.signal.aborted || (options.isEnabled && !options.isEnabled())) return 'drop';
  const body = JSON.stringify({ api_key: options.endpoint.token, batch: options.batch });
  if (Buffer.byteLength(body) > (options.maxBytes ?? 64 * 1024)) return 'drop';
  try {
    const response = await (options.fetch ?? fetch)(new URL('/batch/', options.endpoint.url), {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 1500)]),
    });
    if (!response.ok) return response.status === 429 || response.status >= 500 ? 'retry' : 'drop';
    const receipt = await response.json() as { status?: number | string; quota_limited?: unknown };
    const limited = receipt.quota_limited;
    const quotaLimited = Array.isArray(limited) ? limited.length > 0
      : limited && typeof limited === 'object' ? Object.keys(limited).length > 0 : !!limited;
    return (receipt.status === 1 || receipt.status === 'Ok') && !quotaLimited ? 'accepted' : 'retry';
  } catch {
    return options.signal.aborted ? 'drop' : 'retry';
  }
}

export function createPosthogSender(options: {
  host: string; token: string; identity: Identity; appVersion: string; device?: () => Promise<DeviceIdentity>;
  env: 'development' | 'test' | 'production'; testRunId?: string; timeoutMs?: number; fetch?: typeof fetch; geoip?: boolean; source?: () => string | null;
  isEnabled?: () => boolean;
}) {
  const endpoint = parsePosthogEndpoint(options);
  return async (events: readonly PendingEvent[], signal: AbortSignal): Promise<Receipt> => {
    const device = options.device ? await options.device() : unknownDevice;
    if (signal.aborted || (options.isEnabled && !options.isEnabled())) return 'drop';
    const source = options.source?.() ?? options.identity.utm_source;
    const batch = events.map(event => ({
      event: event.event,
      uuid: event.event_id,
      timestamp: event.occurred_at,
      properties: {
        ...event.properties,
        ...posthogCommonProperties({
          endpoint,
          identity: options.identity,
          device,
          appVersion: options.appVersion,
          source,
          eventId: event.event_id,
          occurredAt: event.occurred_at,
          entrypoint: event.entrypoint,
          hostContext: event.host_context,
          deviceTimezone: event.device_timezone,
          utcOffsetMinutes: event.utc_offset_minutes,
        }),
      },
    }));
    return postPosthogBatch({
      endpoint,
      batch,
      signal,
      maxBytes: 64 * 1024,
      timeoutMs: options.timeoutMs ?? 1500,
      fetch: options.fetch,
      isEnabled: options.isEnabled,
    });
  };
}

export function createNodeTracking<const R extends Registry>(options: {
  registry: R; identity: Identity; host: string; token?: string; appVersion: string; device?: () => Promise<DeviceIdentity>;
  env: 'development' | 'test' | 'production'; testRunId?: string; entrypoint: Entry;
  enabled: boolean; timeoutMs?: number; flushIntervalMs?: number; maxQueue?: number; geoip?: boolean; source?: () => string | null; isEnabled?: () => boolean;
}) {
  const enabled = options.enabled && !!options.token;
  const send = enabled ? createPosthogSender({ ...options, token: options.token! }) : async () => 'drop' as const;
  return createTracker({ ...options, enabled, send });
}
