import test from 'node:test';
import assert from 'node:assert/strict';
import { clientErrorMessage, isFilesystemError } from '../shared/client-error.ts';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';
import type { Service } from '../server.ts';

const filesystemError = (code: string, syscall: string, file: string) =>
  Object.assign(new Error(`${code}: something went wrong, ${syscall} '${file}'`), { code, syscall, path: file });

test('filesystem failures lose the absolute path and keep the code', () => {
  const windows = filesystemError('ENOENT', 'stat', 'C:\\motion-data\\workspace\\probe.md');
  const message = clientErrorMessage(windows, 'fallback');
  assert.equal(isFilesystemError(windows), true);
  assert(!message.includes('C:\\'), message);
  assert(!message.includes('motion-data'), message);
  assert(message.includes('ENOENT'), message);

  const posix = filesystemError('EACCES', 'open', '/srv/motion/workspace/project.md');
  const posixMessage = clientErrorMessage(posix, 'fallback');
  assert(!posixMessage.includes('/srv/motion'), posixMessage);
  assert(posixMessage.includes('EACCES'), posixMessage);
});

test('every errno that carries the resolved path is masked, not only a short list', () => {
  // Directory preparation collides with a regular file, and removal of a non-empty
  // directory, both reach the workspace with `path` set and an errno outside a short list.
  for (const [code, syscall] of [['EEXIST', 'mkdir'], ['ENOTEMPTY', 'rmdir'], ['EIO', 'open'], ['EDQUOT', 'write'], ['EFBIG', 'write']]) {
    const error = filesystemError(code, syscall, '/srv/motion/workspace/nested');
    assert.equal(isFilesystemError(error), true, code);
    assert(!clientErrorMessage(error, 'fallback').includes('/srv/motion'), code);
  }
});

test('application errors keep their own message', () => {
  // Brand Kit "not found" reuses the ENOENT code but is not a node:fs error.
  assert.equal(clientErrorMessage(Object.assign(new Error('Brand Kit not found'), { code: 'ENOENT' }), 'fallback'), 'Brand Kit not found');
  assert.equal(clientErrorMessage(new Error('INVALID_ARGUMENT: projectId is required'), 'fallback'), 'INVALID_ARGUMENT: projectId is required');
  assert.equal(clientErrorMessage(new Error('PROJECT_SCOPE_MISMATCH'), 'fallback'), 'PROJECT_SCOPE_MISMATCH');
  assert.equal(isFilesystemError(Object.assign(new Error('Brand Kit not found'), { code: 'ENOENT' })), false);
});

test('non-error values use the caller fallback', () => {
  assert.equal(clientErrorMessage('boom', 'Tool failed'), 'Tool failed');
  assert.equal(clientErrorMessage(undefined, '操作失败'), '操作失败');
  assert.equal(isFilesystemError({ code: 'ENOENT' }), false);
});

test('the phase-one HTTP bridge masks a filesystem failure and keeps a stable code', async () => {
  await fixture(async store => {
    // The bridge rebuilds tool errors from JSON, so masking has to happen before it
    // serializes them; the MCP side cannot classify a round-tripped error.
    const failure = filesystemError('ENOENT', 'stat', `${store.directory}/projects/demo/index.html`);
    const context = {
      runtimeRoot: '/runtime',
      phase1: { call: async () => { throw failure; } },
    } as unknown as Service;
    const request = transport(store, context);

    const response = await request('/motion-api/phase1/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'openmotion_get_project', arguments: {} }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert(!String(body.error).includes(store.directory), String(body.error));
    assert(body.error.includes('ENOENT'), String(body.error));
    assert.equal(body.code, 'FILE_OPERATION_FAILED');
  });
});