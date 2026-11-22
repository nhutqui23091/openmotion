import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isMain } from '../shared/entry.ts';

const run = promisify(execFile);
const blocking = new Set(['high', 'critical']);

/** Advisory entries the repository has reviewed, each scoped to the package it was reviewed in. */
export async function acceptedAdvisories(url = new URL('./dependency-advisories.json', import.meta.url)) {
  return JSON.parse(await readFile(url, 'utf8')).accepted ?? {};
}

const advisoryId = via => (typeof via === 'object' && via?.url ? via.url.split('/').filter(Boolean).pop() : undefined);

/**
 * High or critical advisories in an `npm audit --json` report that no accepted entry covers. The
 * severity that decides is the advisory's own, not the package's maximum, and an accepted entry only
 * suppresses the advisory in the package it was reviewed for.
 */
export function unacceptedAdvisories(report, accepted = {}) {
  const found = new Map();
  for (const [name, item] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of item.via ?? []) {
      const id = advisoryId(via);
      if (!id || !blocking.has(via.severity ?? item.severity)) continue;
      if (accepted[id]?.package === name) continue;
      found.set(id, `${name}: ${via.title ?? 'advisory'} (${via.severity ?? item.severity})`);
    }
  }
  return [...found].map(([id, detail]) => ({ id, detail }));
}

/** Accepted entries that no longer describe a reported advisory in their package. */
export function staleAcceptedAdvisories(report, accepted = {}) {
  const pairs = new Set();
  for (const [name, item] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of item.via ?? []) {
      const id = advisoryId(via);
      if (id) pairs.add(`${name}:${id}`);
    }
  }
  return Object.entries(accepted).filter(([id, entry]) => !pairs.has(`${entry?.package}:${id}`)).map(([id]) => id);
}

/** Only a real audit payload counts. An npm failure body carries no vulnerabilities map. */
export function auditReport(value) {
  if (!value || typeof value !== 'object' || value.error) return undefined;
  return typeof value.vulnerabilities === 'object' && value.vulnerabilities !== null ? value : undefined;
}

async function report() {
  const options = { maxBuffer: 64 * 1024 * 1024 };
  // Windows cannot launch npm.cmd through execFile without a shell; the command line is fixed here.
  const windows = process.platform === 'win32';
  const parse = value => auditReport(JSON.parse(value ?? ''));
  try { return parse((await run(windows ? 'npm.cmd audit --json' : 'npm', windows ? [] : ['audit', '--json'], { ...options, ...(windows ? { shell: true } : {}) })).stdout); }
  catch (error) {
    // npm audit exits non-zero whenever it reports a vulnerability, so the payload decides.
    try { return parse(error.stdout); } catch { return undefined; }
  }
}

if (isMain(import.meta.url)) {
  const audit = await report();
  if (!audit) {
    // A registry outage must not block a review, and silence would hide it. An npm failure body,
    // such as a missing lockfile or a registry 403, lands here too instead of counting as clean.
    console.warn('Dependency advisory check skipped: npm audit did not return a report.');
    process.exit(0);
  }
  const accepted = await acceptedAdvisories();
  const unaccepted = unacceptedAdvisories(audit, accepted);
  for (const { id, detail } of unaccepted) console.error(`Unaccepted dependency advisory ${id}: ${detail}`);
  const stale = staleAcceptedAdvisories(audit, accepted);
  for (const id of stale) console.error(`Accepted dependency advisory ${id} no longer applies to its package; remove it from scripts/dependency-advisories.json.`);
  if (unaccepted.length || stale.length) process.exit(1);
  console.log('Dependency advisories: every high or critical entry is accepted and recorded, and no accepted entry is stale.');
}