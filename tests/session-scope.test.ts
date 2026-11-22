import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';
import { pluginRoot } from '../hyperframes.ts';
import { manageProject } from '../project-management.ts';
import { callTool } from '../mcp.ts';
import { startServer, type Service } from '../server.ts';

const service = { editorToken: 'scope-token' } as unknown as Service;
const foreign = 'a9801d23-e8a1-405c-960a-0eb9da993b70';

test('a project-scoped caller cannot reach another project\'s session over HTTP', () => fixture(async store => {
  const request = transport(store, service);
  const baseSession = store.projectCatalog().sessions!.find(session => session.artifacts.some(artifact => artifact.projectId === 'project'))!.id;
  const copy = await manageProject(store, { action: 'duplicate', projectId: 'project', requestId: 'scope-duplicate' }, pluginRoot);
  const copySession = store.projectCatalog().sessions!.find(session => session.artifacts.some(artifact => artifact.projectId === copy.projectId))!.id;
  assert.notEqual(copySession, baseSession, 'a duplicated project owns its own session');

  const scoped = { headers: { Authorization: 'Bearer scope-token', 'x-opendesign-project-id': copy.projectId } };
  // The scoped caller keeps full access to its own session.
  assert.equal((await request(`/motion-api/sessions/${copySession}`, scoped)).status, 200);
  // The other project's session is not addressable, on the session route or the browser route.
  assert.equal((await request(`/motion-api/sessions/${baseSession}`, scoped)).status, 404);
  assert.equal((await request(`/motion-api/sessions/${baseSession}/browser/tab-1`, scoped)).status, 404);
  assert.equal((await request(`/motion-api/sessions/${baseSession}`, { method: 'PATCH', headers: { ...scoped.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'stolen' }) })).status, 404);
  assert.notEqual((await store.session(baseSession)).title, 'stolen');
  // A single-user request without project scope keeps its previous behaviour.
  assert.equal((await request(`/motion-api/sessions/${baseSession}`)).status, 200);
}));

test('a project-scoped caller keeps the two-phase session flow it starts', () => fixture(async store => {
  const request = transport(store, service);
  const copy = await manageProject(store, { action: 'duplicate', projectId: 'project', requestId: 'scope-two-phase' }, pluginRoot);
  const scoped = { headers: { Authorization: 'Bearer scope-token', 'x-opendesign-project-id': 'project', 'Content-Type': 'application/json' } };
  const revision = (await store.get()).revision;

  const created = await request('/motion-api/sessions', { ...scoped, method: 'POST', body: JSON.stringify({ mode: 'motion', expectedRevision: revision }) });
  assert.equal(created.status, 201, await created.clone().text());
  const { sessionId } = await created.json();
  // The session has no artifact yet, and the caller that created it must still be able to read it.
  assert.equal((await store.session(sessionId)).artifacts.length, 0);
  assert.equal((await request(`/motion-api/sessions/${sessionId}`, scoped)).status, 200);
  assert.equal(store.forProject('project').sessionInProject(sessionId), true);
  // A different project scope still cannot reach the session the first project created.
  const other = { headers: { Authorization: 'Bearer scope-token', 'x-opendesign-project-id': copy.projectId } };
  assert.equal((await request(`/motion-api/sessions/${sessionId}`, other)).status, 404);
}));

test('a scoped caller may only open an artifact of a session it owns', () => fixture(async store => {
  const request = transport(store, service);
  const copy = await manageProject(store, { action: 'duplicate', projectId: 'project', requestId: 'scope-shared' }, pluginRoot);
  const revision = (await store.get()).revision;
  const catalog = store.projectCatalog();
  // A session that predates any project scope and carries two projects' artifacts: the duplicated
  // project's own session is dropped and its artifact moves into the original session, because a
  // project is owned by exactly one artifact across the catalog.
  const session = catalog.sessions.find(item => item.artifacts.some(artifact => artifact.projectId === 'project'));
  catalog.sessions = catalog.sessions.filter(item => !item.artifacts.some(artifact => artifact.projectId === copy.projectId));
  session.artifacts.push({ id: 'artifact-b', projectId: copy.projectId, kind: 'motion-project', title: 'B' });
  await writeFile(path.join(store.directory, 'projects.json'), JSON.stringify(catalog));

  const scoped = { headers: { Authorization: 'Bearer scope-token', 'x-opendesign-project-id': 'project', 'Content-Type': 'application/json' } };
  const open = projectId => request(`/motion-api/sessions/${session.id}/open`, { ...scoped, method: 'POST', body: JSON.stringify({ expectedRevision: revision, projectId }) });
  // The other project's artifact is refused before any editor work starts.
  assert.equal((await open(copy.projectId)).status, 404);
  // Its own artifact passes the ownership rule; a later editor failure is not this guard's concern.
  assert.notEqual((await open('project')).status, 404);
  // The internal authority calls this route without a project scope, because the MCP artifact switch
  // acts for the workspace rather than for the currently selected project. That path must stay open.
  const internal = await request(`/motion-api/sessions/${session.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, projectId: copy.projectId }) });
  assert.notEqual(internal.status, 404);
}));

test('a project-scoped caller cannot reach another project\'s conversation', () => fixture(async store => {
  const request = transport(store, service);
  const copy = await manageProject(store, { action: 'duplicate', projectId: 'project', requestId: 'scope-conversation' }, pluginRoot);
  const scoped = { headers: { Authorization: 'Bearer scope-token', 'x-opendesign-project-id': copy.projectId, 'Content-Type': 'application/json' } };
  const message = { id: crypto.randomUUID(), content: 'scoped write' };
  // A conversation lives in the session that owns the project's artifact, so the other project's
  // messages must be neither readable nor writable through this scope.
  assert.equal((await request('/motion-api/projects/project/conversation', scoped)).status, 404);
  assert.equal((await request('/motion-api/projects/project/conversation', { ...scoped, method: 'POST', body: JSON.stringify(message) })).status, 404);
  assert.equal((await store.conversation('project')).messages.some(item => item.id === message.id), false);
  // The caller's own project stays reachable, and an unscoped workspace request is unchanged.
  assert.equal((await request(`/motion-api/projects/${copy.projectId}/conversation`, scoped)).status, 200);
  assert.equal((await request('/motion-api/projects/project/conversation')).status, 200);
}));

test('a project-scoped caller cannot replay another project\'s session id', () => fixture(async store => {
  const request = transport(store, service);
  const copy = await manageProject(store, { action: 'duplicate', projectId: 'project', requestId: 'scope-replay' }, pluginRoot);
  const base = store.projectCatalog().sessions!.find(session => session.artifacts.some(artifact => artifact.projectId === 'project'))!;
  const scoped = { headers: { Authorization: 'Bearer scope-token', 'x-opendesign-project-id': copy.projectId, 'Content-Type': 'application/json' } };
  // Replaying the id with the session's own title would return its conversation, so the route refuses
  // before the replay branch runs and the refusal carries no messages.
  const replay = await request('/motion-api/sessions', { ...scoped, method: 'POST', body: JSON.stringify({ id: base.id, mode: 'motion', title: base.title }) });
  assert.equal(replay.status, 404);
  assert.equal((await replay.text()).includes('messages'), false);
  // A new client-generated id still creates a session inside the caller's scope.
  const fresh = crypto.randomUUID();
  const created = await request('/motion-api/sessions', { ...scoped, method: 'POST', body: JSON.stringify({ id: fresh, mode: 'motion', title: 'Scoped', expectedRevision: (await store.get()).revision }) });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(store.forProject(copy.projectId).sessionInProject(fresh), true);
}));

test('every create route refuses a foreign session id under a project scope', () => fixture(async store => {
  const request = transport(store, service);
  const copy = await manageProject(store, { action: 'duplicate', projectId: 'project', requestId: 'scope-create-routes' }, pluginRoot);
  const base = store.projectCatalog().sessions!.find(session => session.artifacts.some(artifact => artifact.projectId === 'project'))!;
  const scopedStore = store.forProject(copy.projectId);
  const headers = { Authorization: 'Bearer scope-token', 'x-opendesign-project-id': copy.projectId, 'Content-Type': 'application/json' };
  // The legacy create routes forward the same JSON into the shared session creator, so the replay
  // rule has to hold there too; a fresh id is still created inside the caller's scope.
  const replay = { id: base.id, title: base.title, mode: base.mode, expectedRevision: (await scopedStore.get()).revision };
  for (const route of ['/motion-api/projects', '/motion-api/templates/product-promo/open']) {
    const response = await request(route, { method: 'POST', headers, body: JSON.stringify(replay) });
    assert.equal(response.status, 400, route);
    const body = await response.json();
    assert.equal(body.error, '会话不存在', route);
    assert.equal(JSON.stringify(body).includes('messages'), false, route);
  }
  // A fresh id is not refused by the scope rule; whether the runtime can materialize it is a
  // separate concern that the fixture does not provide here.
  const fresh = await request('/motion-api/projects', { method: 'POST', headers, body: JSON.stringify({ ...replay, id: crypto.randomUUID(), title: 'Scoped project' }) });
  assert.notEqual((await fresh.json()).error, '会话不存在', 'a fresh id is not a scope refusal');
}));

test('a project-scoped caller only lists the sessions it owns', () => fixture(async store => {
  const request = transport(store, service);
  const copy = await manageProject(store, { action: 'duplicate', projectId: 'project', requestId: 'scope-catalog' }, pluginRoot);
  const baseSession = store.projectCatalog().sessions!.find(session => session.artifacts.some(artifact => artifact.projectId === 'project'))!.id;
  const scoped = { headers: { Authorization: 'Bearer scope-token', 'x-opendesign-project-id': copy.projectId } };
  const own = store.forProject(copy.projectId);
  for (const route of ['/motion-api/projects', '/motion-api/sessions']) {
    // The other project's session id, title and artifacts are not part of this caller's view.
    const body = await (await request(route, scoped)).json();
    assert.ok(body.sessions.length > 0, `${route}: the caller still lists its own session`);
    assert.equal(body.sessions.some(session => session.id === baseSession), false, `${route}: the other project's session stays hidden`);
    assert.equal(body.sessions.every(session => own.sessionInProject(session.id)), true, `${route}: only owned sessions are listed`);
    assert.equal(body.sessions.some(session => session.id === body.activeSessionId), true, `${route}: the active session points inside the list`);
    // The unscoped workspace request keeps the whole catalog.
    const all = await (await request(route)).json();
    assert.equal(all.sessions.some(session => session.id === baseSession), true, `${route}: the workspace view is unchanged`);
  }
}));

test('the internal artifact switch acts for the workspace, not for the connection\'s project', { timeout: 180_000 }, () => fixture(async store => {
  const running = await startServer(store, 0, { editorToken: 'scope-token' });
  try {
    const port = (running.server.address() as { port: number }).port;
    await writeFile(path.join(store.directory, 'preview.json'), JSON.stringify({ port }));
    // The connection keeps its own project while the workspace shows the copy, so the version the
    // internal call sends has to come from the workspace authority it is served by.
    const copy = await manageProject(store, { action: 'duplicate', projectId: 'project', requestId: 'scope-authority' }, pluginRoot);
    await store.selectProject(copy.projectId);
    const session = store.projectCatalog().sessions!.find(item => item.artifacts.some(artifact => artifact.projectId === copy.projectId))!;
    const artifact = session.artifacts.find(item => item.projectId === copy.projectId)!;
    const connection = store.forProject('project');
    const opened = await callTool('openmotion_open_artifact', { sessionId: session.id, artifactId: artifact.id, expectedRevision: (await connection.get()).revision }, connection) as any;
    assert.equal(opened.projectId, copy.projectId, 'the documented switch still reaches the conversation artifact');
  } finally {
    await running.close();
  }
}));
