import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedAdvisories, auditReport, staleAcceptedAdvisories, unacceptedAdvisories } from '../scripts/check-dependency-advisories.mjs';

const report = vulnerabilities => ({ vulnerabilities });
const accepted = (name, id) => ({ [id]: { package: name, reason: 'reviewed' } });

test('only high and critical advisories block a change', () => {
  const audit = report({
    low: { severity: 'low', via: [{ url: 'https://github.com/advisories/GHSA-low', title: 'low', severity: 'low' }] },
    moderate: { severity: 'moderate', via: [{ url: 'https://github.com/advisories/GHSA-mod', title: 'moderate', severity: 'moderate' }] },
    high: { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-high', title: 'high', severity: 'high' }] },
    critical: { severity: 'critical', via: [{ url: 'https://github.com/advisories/GHSA-crit', title: 'critical', severity: 'critical' }] },
  });
  assert.deepEqual(unacceptedAdvisories(audit).map(item => item.id).sort(), ['GHSA-crit', 'GHSA-high']);
});

test('the advisory severity decides, not the package maximum', () => {
  const audit = report({
    mixed: { severity: 'critical', via: [
      { url: 'https://github.com/advisories/GHSA-mild', title: 'mild', severity: 'moderate' },
      { url: 'https://github.com/advisories/GHSA-bad', title: 'bad', severity: 'high' },
    ] },
  });
  assert.deepEqual(unacceptedAdvisories(audit).map(item => item.id), ['GHSA-bad']);
});

test('an accepted advisory only covers the package it was reviewed in', () => {
  const audit = report({
    'image-size': { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq', title: 'image-size loop', severity: 'high' }] },
    other: { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq', title: 'same id, other package', severity: 'high' }] },
  });
  assert.deepEqual(unacceptedAdvisories(audit, accepted('image-size', 'GHSA-5p2g-fcmc-qvqq')).map(item => item.id), ['GHSA-5p2g-fcmc-qvqq']);
  assert.deepEqual(unacceptedAdvisories(audit, accepted('other', 'GHSA-5p2g-fcmc-qvqq')).map(item => item.detail.includes('image-size')), [true]);
});

test('a dependency entry that only names another package does not report an advisory', () => {
  const audit = report({ pptxgenjs: { severity: 'high', via: ['image-size'] } });
  assert.deepEqual(unacceptedAdvisories(audit), []);
});

test('an accepted advisory that no longer applies to its package has to leave the list', () => {
  const audit = report({ 'image-size': { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-still', title: 'still', severity: 'high' }] } });
  const entries = { 'GHSA-old': { package: 'image-size', reason: 'gone' }, 'GHSA-still': { package: 'image-size', reason: 'current' }, 'GHSA-elsewhere': { package: 'image-size', reason: 'wrong package' } };
  assert.deepEqual(staleAcceptedAdvisories(audit, entries).sort(), ['GHSA-elsewhere', 'GHSA-old']);
});

test('an npm failure body is not an audit report', () => {
  assert.equal(auditReport({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }), undefined);
  assert.equal(auditReport({ error: { code: 'E403' } }), undefined);
  assert.equal(auditReport(undefined), undefined);
  assert.equal(auditReport({ metadata: {} }), undefined, 'a report without a vulnerabilities map is not usable');
  const empty = report({});
  assert.equal(auditReport(empty), empty);
});

test('the shipped accepted list parses and only ever suppresses its own package', async () => {
  const entries = await acceptedAdvisories();
  for (const [id, entry] of Object.entries(entries)) {
    assert.equal(typeof entry, 'object', id);
    assert.ok(entry.package && entry.reason, id);
    const audit = report({ [entry.package]: { severity: 'high', via: [{ url: `https://github.com/advisories/${id}`, title: 'accepted', severity: 'high' }] } });
    assert.deepEqual(unacceptedAdvisories(audit, entries), []);
  }
});