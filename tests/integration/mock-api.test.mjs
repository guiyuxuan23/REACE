import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { readConfig } from '../../backend/mock/config.mjs';
import { checkSchema, example } from '../../backend/mock/contract.mjs';
import { createMockServer } from '../../backend/mock/server.mjs';
import { TraceApiClient, TraceApiError } from '../../apps/web/src/services/trace-api.ts';

const token = () => randomBytes(24).toString('base64url');
const origin = 'http://127.0.0.1:5173';

async function fixture(t) {
  const secret = token();
  let now = Date.parse(example('VisionAnalyzeRequest').observation.capturedAt);
  const server = createMockServer({ token: secret, allowedOrigins: new Set([origin]) }, { clock: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = { baseUrl, mode: 'mock', timeoutMs: 2_000 };
  const client = new TraceApiClient(config, { token: () => secret });
  return { baseUrl, config, client, secret, advance: ms => { now += ms; } };
}

function matches(code, status) {
  return error => error instanceof TraceApiError && error.code === code && (status === undefined || error.options.status === status);
}

function valid(schema, value) {
  assert.deepEqual(checkSchema(schema, value), []);
  assert.equal(value.meta.source, 'mock');
  return value.data;
}

test('web client reaches health, product filters and unknown attributes over real loopback HTTP', async t => {
  const { client } = await fixture(t);
  const status = valid('HealthResponse', await client.getHealth());
  assert.ok(Object.values(status.dependencies).every(dependency => dependency === 'unchecked'));
  const found = valid('ProductCatalogResponse', await client.listProducts(example('ProductQuery')));
  assert.deepEqual(found.items.map(item => item.id), ['fictional-lip-sample']);
  assert.equal(found.items[0].provenance.status, 'synthetic');
  assert.equal(found.items[0].attributes.shade, null);
  const absent = valid('ProductCatalogResponse', await client.listProducts({ category: 'face' }));
  assert.deepEqual(absent.items, []);
  await assert.rejects(client.listProducts({ ids: ['duplicate', 'duplicate'] }), matches('BAD_REQUEST', 400));
});

test('Agent retries use the original turn identifier and preserve the session', async t => {
  const { client } = await fixture(t);
  const input = example('AgentMessageRequest');
  const firstEnvelope = await client.sendAgentMessage(input, { requestId: 'http-correlation' });
  assert.equal(firstEnvelope.meta.requestId, 'http-correlation');
  const first = valid('AgentMessageResponse', firstEnvelope);
  const same = valid('AgentMessageResponse', await client.sendAgentMessage(input));
  assert.deepEqual(first, same);
  assert.notEqual(first.content.speech, first.content.display.text);
  const next = await client.sendAgentMessage({ ...input, requestId: 'turn-next', sessionId: first.session.id, locale: 'en' });
  assert.equal(next.data.session.id, first.session.id);
  assert.equal(next.data.session.locale, 'en');
  await assert.rejects(client.sendAgentMessage({ ...input, locale: 'en' }), matches('CONFLICT', 409));
  await assert.rejects(client.sendAgentMessage({ ...input, requestId: 'unknown-turn', sessionId: 'missing' }), matches('NOT_FOUND', 404));
});

test('vision requires explicit authorization and fresh structured data; emits no predicted result', async t => {
  const { client, advance } = await fixture(t);
  const input = example('VisionAnalyzeRequest');
  const result = valid('VisionAnalysisResponse', await client.analyzeVision(input));
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.confidence, null);
  assert.deepEqual(result.predictions, []);
  const missing = { ...input, authorization: { ...input.authorization, granted: false } };
  await assert.rejects(client.analyzeVision(missing), matches('FORBIDDEN', 403));
  await assert.rejects(client.analyzeVision({ ...input, image: 'raw-media' }), matches('BAD_REQUEST', 400));
  advance(31_000);
  await assert.rejects(client.analyzeVision(input), matches('CONFLICT', 409));
});

test('memory preview, simultaneous confirm, correction, deletion and revoked replay', async t => {
  const { client } = await fixture(t);
  const proposal = valid('MemoryProposalResponse', await client.proposeMemory(example('MemoryProposalRequest')));
  const confirm = { proposalId: proposal.id, expectedVersion: proposal.version, confirmed: true };
  assert.deepEqual(valid('MemoryProfileResponse', await client.getMemoryProfile()).records, []);
  await assert.rejects(client.confirmMemory({ ...confirm, confirmed: false }), matches('FORBIDDEN', 403));
  await assert.rejects(client.confirmMemory({ ...confirm, expectedVersion: 2 }), matches('CONFLICT', 409));
  const [first, repeated] = (await Promise.all([client.confirmMemory(confirm), client.confirmMemory(confirm)]))
    .map(reply => valid('MemoryConfirmationResponse', reply));
  assert.deepEqual(first, repeated);
  assert.deepEqual((await client.getMemoryProfile()).data.records, [first]);
  const correction = { ...example('MemoryCorrectionRequest'), memoryId: first.id, expectedVersion: first.version };
  const [edit, concurrent] = await Promise.all([client.proposeMemory(correction), client.proposeMemory(correction)]);
  const changed = await client.confirmMemory({ ...confirm, proposalId: edit.data.id });
  assert.equal(changed.data.id, first.id);
  assert.equal(changed.data.version, first.version + 1);
  await assert.rejects(client.confirmMemory({ ...confirm, proposalId: concurrent.data.id }), matches('CONFLICT', 409));
  assert.equal(valid('MemoryDeletionResponse', await client.deleteMemory(first.id)).status, 'deleted');
  assert.equal((await client.deleteMemory(first.id)).data.status, 'deleted');
  assert.deepEqual((await client.getMemoryProfile()).data.records, []);
  await assert.rejects(client.confirmMemory(confirm), matches('CONFLICT', 409));
});

test('unconfirmed candidates expire without saving', async t => {
  const { client, advance } = await fixture(t);
  const proposal = (await client.proposeMemory(example('MemoryProposalRequest'))).data;
  advance(5 * 60_000 + 1);
  await assert.rejects(client.confirmMemory({ proposalId: proposal.id, expectedVersion: 1, confirmed: true }), matches('CONFLICT', 409));
  assert.deepEqual((await client.getMemoryProfile()).data.records, []);
});

test('Bearer, CORS, methods and body guards return contract errors', async t => {
  const { baseUrl, secret } = await fixture(t);
  const unauthorized = await fetch(`${baseUrl}/api/v1/memory/profile`);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /Bearer/);
  assert.equal(valid('ErrorResponse', await unauthorized.json()), undefined);
  const cors = await fetch(`${baseUrl}/api/v1/agent/message`, {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get('access-control-allow-origin'), origin);
  const denied = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://unapproved.invalid' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.has('access-control-allow-origin'), false);
  const noOrigin = await fetch(`${baseUrl}/api/v1/agent/message`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(noOrigin.status, 400);
  assert.equal((await fetch(`${baseUrl}/health`, { method: 'POST' })).status, 405);
  const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
  const badJson = await fetch(`${baseUrl}/api/v1/agent/message`, { method: 'POST', headers, body: '{' });
  assert.equal(badJson.status, 400);
  const oversized = await fetch(`${baseUrl}/api/v1/agent/message`, { method: 'POST', headers, body: 'x'.repeat(17_000) });
  assert.equal(oversized.status, 413);
});

test('live selection rejects a mock; timeout and cancellation are distinct without fallback', async t => {
  const { config } = await fixture(t);
  const live = new TraceApiClient({ ...config, mode: 'live' });
  await assert.rejects(live.getHealth(), matches('BAD_RESPONSE', 200));
  const wait = (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5_000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  const slow = new TraceApiClient({ ...config, timeoutMs: 25 }, { fetch: wait });
  await assert.rejects(slow.getHealth(), matches('TIMEOUT'));
  const abort = new AbortController();
  const active = slow.getHealth({ signal: abort.signal });
  abort.abort();
  await assert.rejects(active, matches('CANCELLED'));
});

test('environment checks keep mock off outside explicit loopback development', () => {
  const env = { TRACE_ENV: 'development', TRACE_ENABLE_MOCK: 'true', TRACE_MOCK_TOKEN: token() };
  assert.equal(readConfig(env).port, 8001);
  assert.throws(() => readConfig({ ...env, NODE_ENV: 'production' }), /development/);
  assert.throws(() => readConfig({ ...env, BACKEND_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => readConfig({ ...env, WEB_PORT: '8001' }), /distinct/);
  assert.throws(() => readConfig({ ...env, TRACE_ALLOWED_ORIGINS: '*' }), /origin/i);
  assert.throws(() => new TraceApiClient({ baseUrl: 'http://example.invalid', mode: 'live', timeoutMs: 100 }), /HTTPS/);
});
