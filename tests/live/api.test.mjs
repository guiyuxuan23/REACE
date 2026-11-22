import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import test from 'node:test';
import { TraceApiClient } from '../../apps/web/src/services/trace-api.ts';
import { checkSchema, example } from '../../backend/mock/contract.mjs';

const base = process.env.TRACE_TEST_BASE;
const token = process.env.TRACE_TEST_TOKEN;
const fixture = process.env.TRACE_TEST_FIXTURE;
const phase = process.env.TRACE_TEST_PHASE;
const paths = { agent: '/api/v1/agent/message', vision: '/api/v1/vision/analyze', products: '/api/v1/products',
  profile: '/api/v1/memory/profile', proposals: '/api/v1/memory/proposals', confirm: '/api/v1/memory/confirm' };

async function call(path, { method = 'GET', body, status = 200, schema, headers = {} } = {}) {
  const id = 'trace-test-request';
  const response = await fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Request-Id': id,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  assert.deepEqual(value.meta, { apiVersion: 'v1', source: 'live', requestId: id });
  assert.deepEqual(checkSchema(schema ?? 'ErrorResponse', value), []);
  return value.data ?? value.error;
}

function turnBody(requestId, text, sessionId) {
  return { requestId, ...(sessionId ? { sessionId } : {}), locale: 'zh-CN', message: { kind: 'text', text } };
}

function turn(body, status = 200) {
  return call(paths.agent, { method: 'POST', body, status, schema: status === 200 ? 'AgentMessageResponse' : undefined });
}

function proposed(body) {
  return call(paths.proposals, { method: 'POST', body, status: 201, schema: 'MemoryProposalResponse' });
}

function confirm(proposal, expectedVersion = proposal.version, confirmed = true, status = 200) {
  return call(paths.confirm, { method: 'POST', body: { proposalId: proposal.id, expectedVersion, confirmed },
    status, schema: status === 200 ? 'MemoryConfirmationResponse' : undefined });
}

function profile() {
  return call(paths.profile, { schema: 'MemoryProfileResponse' });
}

if (phase === 'initial') {
  const state = {};

  await test('live health, Bearer requirement, host and browser boundary', async () => {
    const health = await call('/health', { schema: 'HealthResponse', headers: { Authorization: '' } });
    assert.deepEqual(health.dependencies, { agent: 'healthy', vision: 'unchecked', memory: 'healthy', products: 'healthy' });
    assert.equal((await call(paths.profile, { status: 401, headers: { Authorization: 'Bearer invalid' } })).code,
      'UNAUTHENTICATED');
    assert.equal((await call('/health', { status: 403, headers: { Origin: 'https://example.invalid' } })).code, 'FORBIDDEN');
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const req = request(base + '/health', { headers: { Host: 'example.invalid' }, timeout: 2_000 }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('host boundary timeout')));
      req.end();
    });
    assert.equal(wrongHostStatus, 403);
    await call('/api/identity', { status: 404 });
    await call(paths.agent, { status: 405 });
  });

  await test('Chinese V1 course produces real plan instructions, controls and completion over the v1 API', async () => {
    const body = turnBody('goal', '我想画个十五分钟的自然日常妆');
    const proposedCourse = await turn(body);
    const session = state.session = proposedCourse.session.id;
    assert.equal(proposedCourse.session.workflow.stage, 'conversation');
    assert.match(proposedCourse.content.display.text, /待审核原创课程/);
    assert.match(proposedCourse.content.speech, /自然妆|日常/);
    assert.deepEqual(await turn(body), proposedCourse);
    assert.equal((await turn({ ...body, message: { kind: 'text', text: '开始' } }, 409)).code, 'CONFLICT');
    assert.equal((await turn(turnBody('bad-session', '开始', 'unknown-session'), 404)).code, 'NOT_FOUND');
    const first = await turn(turnBody('start', '开始', session));
    assert.equal(first.session.workflow.stage, 'guidance');
    assert.match(first.content.speech, /[\u4e00-\u9fff]/);
    const step = first.session.workflow.stepId;
    assert.ok(step);
    assert.equal((await turn(turnBody('repeat', '再说一遍', session))).session.workflow.stepId, step);
    const paused = await turn(turnBody('pause', '暂停', session));
    assert.equal(paused.session.workflow.stage, 'paused');
    assert.equal(paused.session.workflow.stepId, step);
    assert.equal((await turn(turnBody('resume', '恢复', session))).session.workflow.stage, 'guidance');
    const advance = turnBody('advance', '下一步', session);
    const moves = await Promise.all([turn(advance), turn(advance)]);
    assert.deepEqual(moves[0], moves[1]);
    assert.notEqual(moves[0].session.workflow.stepId, step);
    const skipped = await turn(turnBody('skip', '跳过', session));
    assert.notEqual(skipped.session.workflow.stepId, moves[0].session.workflow.stepId);
    const finished = await turn(turnBody('finish', '结束今天', session));
    assert.equal(finished.session.workflow.stage, 'completed');
    assert.match(finished.content.display.text, /本次教学已结束/);
    assert.match(finished.content.speech, /本次教学已结束/);
    assert.equal((await turn(turnBody('save-in-chat', '保存到我的记录', session), 403)).code, 'FORBIDDEN');
    assert.equal((await turn(turnBody('unsupported-chat', '今天天气如何'), 503)).retryable, false);
  });

  await test('vision never claims a result from metadata or accepts raw image bytes', async () => {
    const body = example('VisionAnalyzeRequest');
    body.observation.capturedAt = new Date().toISOString();
    const invoke = (payload, status) => call(paths.vision, { method: 'POST', body: payload, status });
    assert.equal((await invoke({ ...body, sessionId: state.session }, 503)).retryable, false);
    assert.equal((await invoke({ ...body, authorization: { ...body.authorization, granted: false } }, 403)).code, 'FORBIDDEN');
    await invoke({ ...body, observation: { ...body.observation, capturedAt: '2020-01-01T00:00:00Z' } }, 409);
    await invoke({ ...body, observation: { ...body.observation, capturedAt: Date.now() } }, 400);
    await invoke({ ...body, observation: { ...body.observation, rawImage: 'ZmFrZQ==' } }, 400);
    await invoke({ ...body, sessionId: null }, 400);
  });

  await test('V1 product provenance and shared typed client with cancellation', async () => {
    assert.deepEqual(await call(`${paths.products}?category=lips&ids=sample_01&ids=unlisted`,
      { schema: 'ProductCatalogResponse' }), { items: [] });
    await call(`${paths.products}?ids=sample_01&ids=sample_01`, { status: 400 });
    const live = new TraceApiClient({ mode: 'live', baseUrl: base, timeoutMs: 10_000 }, { token: () => token });
    assert.equal((await live.getHealth()).meta.source, 'live');
    assert.deepEqual((await live.listProducts()).data.items, []);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(live.getMemoryProfile({ signal: cancelled.signal }), { code: 'CANCELLED' });
  });

  await test('memory preview, explicit confirmation, concurrent replays and versioned correction', async () => {
    const preference = { key: 'finish', value: '偏好验证用自然妆效' };
    const proposedMemory = await proposed({ operation: 'create', preference });
    assert.deepEqual(await profile(), { records: [] });
    await confirm(proposedMemory, 1, false, 403);
    await confirm(proposedMemory, 2, true, 409);
    const saved = await Promise.all([confirm(proposedMemory), confirm(proposedMemory)]);
    assert.deepEqual(saved[0], saved[1]);
    assert.deepEqual(await profile(), { records: [saved[0]] });
    const args = { operation: 'correct', memoryId: saved[0].id, expectedVersion: saved[0].version,
      preference: { key: 'fragrance', value: '偏好验证用无香' } };
    const first = await proposed(args);
    const competing = await proposed(args);
    const replacement = state.record = await confirm(first);
    assert.equal(replacement.version, 2);
    assert.equal(replacement.id, saved[0].id);
    await confirm(competing, 1, true, 409);
    await confirm(proposedMemory, 1, true, 409);
    assert.deepEqual(await profile(), { records: [replacement] });
    state.pending = await proposed({ operation: 'create', preference: { key: 'tools', value: '仅预览' } });
  });

  await test('invalid or oversized requests leave the service usable', async () => {
    await call(paths.agent, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: {}, status: 415 });
    await call(paths.agent, { method: 'POST', body: { oversized: 'x'.repeat(16_500) }, status: 413 });
    await turn({ ...turnBody('extra', '开始'), userId: 'another-person' }, 400);
    assert.deepEqual(await profile(), { records: [state.record] });
    writeFileSync(fixture, JSON.stringify(state));
  });
} else if (phase === 'restart') {
  await test('SQLite survives restart, unconfirmed proposals expire, delete prevents replay', async () => {
    const { session, record, pending } = JSON.parse(readFileSync(fixture, 'utf8'));
    assert.deepEqual(await profile(), { records: [record] });
    await confirm(pending, 1, true, 404);
    assert.equal((await turn(turnBody('restored', '结束今天', session))).session.workflow.stage, 'completed');
    const fresh = await proposed({ operation: 'create', preference: { key: 'tools', value: '删除验证用刷具' } });
    const saved = await confirm(fresh);
    const remove = () => call(`/api/v1/memory/${saved.id}`, { method: 'DELETE', schema: 'MemoryDeletionResponse' });
    assert.deepEqual(await remove(), { id: saved.id, status: 'deleted' });
    assert.deepEqual(await remove(), { id: saved.id, status: 'deleted' });
    await confirm(fresh, 1, true, 409);
    assert.deepEqual(await profile(), { records: [record] });
  });
} else if (phase === 'different-owner') {
  await test('new local bearer cannot read or alter prior owner’s session or preference', async () => {
    const { session, record } = JSON.parse(readFileSync(fixture, 'utf8'));
    assert.deepEqual(await profile(), { records: [] });
    await turn(turnBody('other-owner', '下一步', session), 404);
    await call(`/api/v1/memory/${record.id}`, { method: 'DELETE', status: 404 });
    await call(paths.proposals, { method: 'POST', body: { operation: 'correct', memoryId: record.id,
      expectedVersion: record.version, preference: { key: 'finish', value: '另一位使用者' } }, status: 404 });
  });
} else {
  throw new Error('Run this test with scripts/test-live.py.');
}
