import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readConfig } from './config.mjs';
import { checkSchema, example } from './contract.mjs';
import { ApiFault, createScenarios } from './scenarios.mjs';

const MAX_BODY_BYTES = 16_384;
const ERROR_CODES = new Map([
  [400, 'BAD_REQUEST'], [401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
  [405, 'METHOD_NOT_ALLOWED'], [409, 'CONFLICT'], [413, 'PAYLOAD_TOO_LARGE'],
  [415, 'UNSUPPORTED_MEDIA_TYPE'], [500, 'INTERNAL_ERROR'], [503, 'UNAVAILABLE'],
]);

const routes = [
  { path: '/api/v1/agent/message', method: 'POST', action: 'agent', input: 'AgentMessageRequest', output: 'AgentMessageResponse' },
  { path: '/api/v1/vision/analyze', method: 'POST', action: 'vision', input: 'VisionAnalyzeRequest', output: 'VisionAnalysisResponse' },
  { path: '/api/v1/memory/profile', method: 'GET', action: 'profile', output: 'MemoryProfileResponse' },
  { path: '/api/v1/memory/proposals', method: 'POST', action: 'propose', input: 'MemoryProposalRequest', output: 'MemoryProposalResponse', status: 201 },
  { path: '/api/v1/memory/confirm', method: 'POST', action: 'confirm', input: 'MemoryConfirmRequest', output: 'MemoryConfirmationResponse' },
  { path: '/api/v1/memory/{memory_id}', method: 'DELETE', action: 'delete', output: 'MemoryDeletionResponse' },
  { path: '/api/v1/products', method: 'GET', action: 'products', output: 'ProductCatalogResponse' },
  { path: '/health', method: 'GET', action: 'health', output: 'HealthResponse', public: true },
];

function findRoute(path, method) {
  const exact = routes.find(route => route.path === path);
  if (exact) return { route: exact };
  const match = /^\/api\/v1\/memory\/([^/]+)$/.exec(path);
  if (match && method === 'DELETE') return { route: routes.find(route => route.action === 'delete'), identifier: match[1] };
  throw new ApiFault(404, 'Route not found.');
}

function verify(name, value) {
  if (checkSchema(name, value).length) throw new ApiFault(400, 'Request does not match the v1 contract.');
  return value;
}

async function readJson(request) {
  if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiFault(415, 'Content-Type must be application/json.');
  }
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) throw new ApiFault(413, 'Request body is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiFault(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiFault(400, 'Request body must be valid UTF-8 JSON.');
  }
}

function parseQuery(params, action) {
  if (action !== 'products') {
    if (params.size) throw new ApiFault(400, 'This endpoint accepts no query parameters.');
    return;
  }
  const allowed = new Set(['category', 'ids']);
  if ([...params.keys()].some(key => !allowed.has(key)) || params.getAll('category').length > 1) {
    throw new ApiFault(400, 'Unsupported or repeated product filter.');
  }
  const query = {};
  if (params.has('category')) query.category = params.get('category');
  if (params.has('ids')) query.ids = params.getAll('ids');
  return verify('ProductQuery', query);
}

function authorized(actual, expected) {
  if (typeof actual !== 'string') return false;
  const header = Buffer.from(actual);
  return header.length === expected.length && timingSafeEqual(header, expected);
}

export function createMockServer(config, { clock = Date.now, servePreview } = {}) {
  const scenarios = createScenarios(clock, example, randomUUID);
  const expectedAuth = Buffer.from(`Bearer ${config.token}`);
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    if (servePreview?.(request, response)) return;
    const incomingId = request.headers['x-request-id'];
    const validId = incomingId === undefined || checkSchema('Identifier', incomingId).length === 0;
    const meta = { apiVersion: 'v1', source: 'mock', requestId: validId ? incomingId ?? randomUUID() : randomUUID() };
    const send = (status, body) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-trace-source': 'mock' });
      response.end(JSON.stringify(body));
    };

    try {
      const origin = request.headers.origin;
      response.setHeader('Vary', 'Origin');
      if (origin) {
        if (!config.allowedOrigins.has(origin)) throw new ApiFault(403, 'Development origin is not authorized.');
        response.setHeader('Access-Control-Allow-Origin', origin);
      }
      if (request.method === 'OPTIONS' && !origin) throw new ApiFault(400, 'CORS preflight requires an origin.');
      const url = new URL(request.url, 'http://127.0.0.1');
      const method = request.method === 'OPTIONS' ? request.headers['access-control-request-method'] : request.method;
      const { route, identifier } = findRoute(url.pathname, method);
      if (method !== route.method) {
        response.setHeader('Allow', route.method);
        throw new ApiFault(405, 'HTTP method is not allowed.');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', route.method);
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
        response.setHeader('Access-Control-Max-Age', '300');
        response.writeHead(204).end();
        return;
      }
      if (!route.public && !authorized(request.headers.authorization, expectedAuth)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        throw new ApiFault(401, 'Authentication required.');
      }
      if (!validId) throw new ApiFault(400, 'Invalid X-Request-Id.');
      const query = parseQuery(url.searchParams, route.action);
      let input = query;
      if (identifier !== undefined) input = verify('Identifier', identifier);
      if (route.input) input = verify(route.input, await readJson(request));
      const data = scenarios[route.action](input);
      const envelope = { meta, data };
      if (checkSchema(route.output, envelope).length) throw new Error('Response schema mismatch.');
      send(route.status ?? 200, envelope);
    } catch (cause) {
      request.resume();
      const fault = cause instanceof ApiFault ? cause : new ApiFault(500, 'The mock could not produce a contract response.');
      if (fault.status === 413) response.setHeader('Connection', 'close');
      send(fault.status, { meta, error: { code: ERROR_CODES.get(fault.status), message: fault.message, retryable: fault.status === 503 } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig(process.env);
    const server = createMockServer(config);
    server.on('error', error => {
      console.error(`TRACE mock could not start (${error.code ?? 'unknown error'}).`);
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      console.log(`TRACE development mock (synthetic) listening on ${config.host}:${config.port}.`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
