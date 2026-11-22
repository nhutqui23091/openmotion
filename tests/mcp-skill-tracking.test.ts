import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.ts';
import { rpc, mcpRegistry } from '../mcp.ts';
import { validProperties } from '../tracking/core.ts';
import { omEvents } from '../tracking/events.ts';
import { toolInputFields, toolResultFields } from '../tracking/tool-fields.ts';

test('library Skill tool calls report the requested skill id and bounded results', () => fixture(async store => {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  store.tracking = { track: (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); } } as any;
  const registry = mcpRegistry('phase1');
  const call = (id: number, name: string, args: Record<string, unknown>) => rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, store, registry);
  const list = (await call(1, 'openmotion_list_skills', {}) as any).result.structuredContent;
  const detail = (await call(2, 'openmotion_get_skill', { skillId: 'openmotion-design-remix' }) as any).result.structuredContent;
  const missing = (await call(3, 'openmotion_get_skill', { skillId: 'no-such-skill' }) as any).result;
  assert.equal(missing.structuredContent.error.code, 'SKILL_NOT_FOUND');
  const finished = events.filter(item => item.event === 'mcp_tool_finished').map(item => item.fields);
  assert.deepEqual(finished.map(fields => [fields.tool_name, fields.skill_id, fields.outcome, fields.result_count, fields.skill_source, fields.skill_file_count, fields.error_code]), [
    ['motion_list_skills', undefined, 'success', list.total, list.source, undefined, undefined],
    ['motion_get_skill', 'openmotion-design-remix', 'success', undefined, detail.source, detail.files.length, undefined],
    ['motion_get_skill', 'no-such-skill', 'failure', undefined, undefined, undefined, 'SKILL_NOT_FOUND'],
  ]);
  assert(list.total > 0 && detail.files.length > 0);
  assert.deepEqual(events.filter(item => item.event === 'mcp_tool_started').map(item => item.fields.skill_id), [undefined, 'openmotion-design-remix', 'no-such-skill']);
  for (const { event, fields } of events) assert(validProperties(omEvents, event, fields), `${event} must pass the tracking allowlist`);
}));

test('Skill tracking fields drop anything that is not a public slug or a bounded count', () => {
  assert.deepEqual(toolInputFields('openmotion_get_skill', { skillId: '../PRIVATE PATH' }), {});
  assert.deepEqual(toolInputFields('openmotion_get_template', { templateId: 'openmotion-design-remix' }), {});
  assert.deepEqual(toolResultFields('openmotion_list_skills', { total: -1, source: 'PRIVATE', indexPath: '/private/index.jsonl' }), {});
  assert.deepEqual(toolResultFields('openmotion_get_skill', { source: 'hosted', files: ['SKILL.md', 'a.js'], instructions: 'PRIVATE' }), { skill_source: 'hosted', skill_file_count: 2 });
  assert.deepEqual(toolResultFields('openmotion_get_template', { total: 3, source: 'hosted' }), {});
  const base = { tool_name: 'motion_get_skill', call_id: crypto.randomUUID(), accepted: true, outcome: 'success', duration_ms: 1 };
  assert(!validProperties(omEvents, 'mcp_tool_finished', { ...base, skill_id: 'PRIVATE PATH/../x' }));
  assert(!validProperties(omEvents, 'mcp_tool_finished', { ...base, skill_source: 'PRIVATE' }));
});
