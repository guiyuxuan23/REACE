const LOOPBACK = new Set(['127.0.0.1', '::1']);

function readPort(env, name, fallback) {
  const value = env[name] ?? String(fallback);
  const port = Number(value);
  if (!/^\d{1,5}$/.test(value) || port < 1 || port > 65535) throw new Error(`${name} must be a port from 1 to 65535.`);
  return port;
}

function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid TRACE_ALLOWED_ORIGINS item.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
    throw new Error('TRACE_ALLOWED_ORIGINS requires exact HTTP(S) origins without paths.');
  }
  return value;
}

export function readConfig(env) {
  if (env.TRACE_ENV !== 'development' || env.TRACE_ENABLE_MOCK !== 'true' || env.NODE_ENV === 'production') {
    throw new Error('TRACE mock requires development mode and explicit TRACE_ENABLE_MOCK=true.');
  }
  const host = env.BACKEND_HOST ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new Error('The development mock binds only to a loopback IP.');
  const port = readPort(env, 'MOCK_API_PORT', 8001);
  const webPort = readPort(env, 'WEB_PORT', 5173);
  const backendPort = readPort(env, 'BACKEND_PORT', 8000);
  if (new Set([port, webPort, backendPort]).size !== 3) throw new Error('Mock, web and backend ports must be distinct.');
  const token = env.TRACE_MOCK_TOKEN ?? '';
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(token)) throw new Error('Set a development-only TRACE_MOCK_TOKEN (16–128 token characters).');
  const origins = (env.TRACE_ALLOWED_ORIGINS ?? `http://127.0.0.1:${webPort},http://localhost:${webPort}`);
  return { host, port, token, allowedOrigins: new Set(origins.split(',').map(value => value.trim()).filter(Boolean).map(origin)) };
}
