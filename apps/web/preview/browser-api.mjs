import { ApiFault, createScenarios } from '../../../backend/mock/scenarios.mjs';
import { fixtures } from './browser-fixtures.mjs';

const procedures = new Map([
  ['POST /api/v1/agent/message', 'agent'],
  ['POST /api/v1/vision/analyze', 'vision'],
  ['GET /api/v1/memory/profile', 'profile'],
  ['POST /api/v1/memory/proposals', 'propose'],
  ['POST /api/v1/memory/confirm', 'confirm'],
]);
const faultCode = new Map([[403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'CONFLICT'], [503, 'UNAVAILABLE']]);

export function createBrowserTransport() {
  const uuid = () => crypto.randomUUID();
  const scenarios = createScenarios(Date.now, name => structuredClone(fixtures[name].value), uuid);
  return async (input, init) => {
    // This adapter handles preview interactions wholly in this tab, without issuing an HTTP request.
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const path = new URL(request.url).pathname;
    const meta = { apiVersion: 'v1', source: 'mock', requestId: request.headers.get('X-Request-Id') ?? uuid() };
    const options = { headers: { 'Cache-Control': 'no-store' } };
    try {
      const action = procedures.get(`${request.method} ${path}`);
      if (action === 'profile') return Response.json({ meta, data: scenarios.profile() }, options);
      if (action) {
        const body = await request.json();
        request.signal.throwIfAborted();
        return Response.json({ meta, data: scenarios[action](body) }, { ...options, status: action === 'propose' ? 201 : 200 });
      }
      const remove = /^\/api\/v1\/memory\/([A-Za-z0-9_-]{1,80})$/.exec(path);
      if (request.method === 'DELETE' && remove) return Response.json({ meta, data: scenarios.delete(remove[1]) }, options);
      throw new ApiFault(404, '网页演练暂不支持此操作。');
    } catch (error) {
      if (!(error instanceof ApiFault)) throw error;
      return Response.json({ meta, error: { code: faultCode.get(error.status), message: error.message,
        retryable: false } }, { ...options, status: error.status });
    }
  };
}
