export type ApiMode = 'mock' | 'live';

export interface ApiConfig {
  mode: ApiMode;
  baseUrl: string;
  timeoutMs: number;
}

export function normalizeConfig(config: ApiConfig): ApiConfig {
  if (config.mode !== 'mock' && config.mode !== 'live') throw new TypeError('Unknown TRACE API mode.');
  const url = new URL(config.baseUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    (config.mode === 'mock' && !loopback)
  ) throw new TypeError('TRACE requires an origin URL and uses HTTPS off loopback. Mock stays on loopback.');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120_000) {
    throw new TypeError('TRACE API timeout must be between 1 and 120000 milliseconds.');
  }
  return { ...config, baseUrl: url.origin };
}

export function configFromEnv(env: Record<string, string | undefined>): ApiConfig {
  const mode = env.VITE_API_MODE ?? 'mock';
  if (mode !== 'live' && mode !== 'mock') throw new TypeError('VITE_API_MODE must be mock or live.');
  const port = mode === 'mock' ? 8001 : 8000;
  return normalizeConfig({
    mode,
    baseUrl: env.VITE_API_BASE_URL ?? `http://127.0.0.1:${port}`,
    timeoutMs: Number(env.VITE_API_TIMEOUT_MS ?? 10_000),
  });
}
