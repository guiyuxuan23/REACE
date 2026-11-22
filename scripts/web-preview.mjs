import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMockServer } from '../backend/mock/server.mjs';

const root = new URL('../', import.meta.url);
const art = 'apps/web/preview/';
const emitted = '.trace-preview/';
const mapping = new Map([
  ['/', [art + 'index.html', 'text/html; charset=utf-8']],
  ['/styles.css', [art + 'styles.css', 'text/css; charset=utf-8']],
  ...['preview/main.js', 'preview/media.js', 'preview/copy.js', 'preview/memory.js', 'src/services/trace-api.js', 'src/services/api-config.js'].map(
    path => ['/apps/web/' + path, [emitted + 'apps/web/' + path, 'text/javascript; charset=utf-8']],
  ),
]);

export function createPreview(port) {
  const token = randomBytes(32).toString('base64url');
  const host = `127.0.0.1:${port}`;
  const resources = new Map([...mapping].map(([route, [file, type]]) => {
    const bytes = readFileSync(new URL(file, root));
    return [route, { type, body: route === '/' ? bytes.toString('utf8').replace('__TRACE_LOCAL_TOKEN__', token) : bytes }];
  }));
  return createMockServer({ token, allowedOrigins: new Set([`http://${host}`]) }, { servePreview(request, response) {
    if (request.headers.host !== host || request.headers['sec-fetch-site'] === 'cross-site') {
      response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      return true;
    }
    const resource = resources.get(request.url);
    if (request.method !== 'GET' || !resource) return false;
    response.writeHead(200, {
      'Content-Type': resource.type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; media-src 'self' blob:",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'camera=(self), microphone=()',
    }).end(resource.body);
    return true;
  } });
}

if (process.env.NODE_ENV === 'production') throw new Error('The simulated TRACE preview is local development only.');
const port = Number(process.env.TRACE_PREVIEW_PORT ?? 5180);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TRACE_PREVIEW_PORT must be a valid port.');
const preview = createPreview(port);
preview.on('error', error => { console.error(`TRACE preview failed (${error.code}).`); process.exitCode = 1; });
preview.listen(port, '127.0.0.1', () => console.log(`TRACE 模拟预览 http://127.0.0.1:${port}`));
