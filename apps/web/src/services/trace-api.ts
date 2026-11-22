import type { components } from '../../../../packages/shared-contracts/v1.ts';
import { normalizeConfig, type ApiConfig } from './api-config.ts';

type Schema = components['schemas'];
type ErrorPayload = Schema['ErrorResponse']['error'];
type Failure = ErrorPayload['code'] | 'BAD_RESPONSE' | 'NETWORK' | 'TIMEOUT' | 'CANCELLED';

export class TraceApiError extends Error {
  readonly code: Failure;
  readonly options: { status?: number; requestId?: string; retryable?: boolean };

  constructor(
    message: string,
    code: Failure,
    options: { status?: number; requestId?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'TraceApiError';
    this.code = code;
    this.options = options;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  requestId?: string;
}

interface Transport {
  fetch?: typeof fetch;
  token?: () => string | undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function failure(value: unknown): value is ErrorPayload {
  const data = object(value);
  return typeof data?.code === 'string' && typeof data.message === 'string' && typeof data.retryable === 'boolean';
}

const identifier = /^[A-Za-z0-9_-]{1,80}$/;

export class TraceApiClient {
  private readonly config: ApiConfig;
  private readonly http: typeof fetch;
  private readonly token: () => string | undefined;

  constructor(config: ApiConfig, transport: Transport = {}) {
    this.config = normalizeConfig(config);
    this.http = transport.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = transport.token ?? (() => undefined);
  }

  sendAgentMessage(body: Schema['AgentMessageRequest'], options?: RequestOptions) {
    return this.request<Schema['AgentMessageResponse']>('POST', '/api/v1/agent/message', options, body);
  }

  analyzeVision(body: Schema['VisionAnalyzeRequest'], options?: RequestOptions) {
    return this.request<Schema['VisionAnalysisResponse']>('POST', '/api/v1/vision/analyze', options, body);
  }

  getMemoryProfile(options?: RequestOptions) {
    return this.request<Schema['MemoryProfileResponse']>('GET', '/api/v1/memory/profile', options);
  }

  proposeMemory(body: Schema['MemoryProposalRequest'], options?: RequestOptions) {
    return this.request<Schema['MemoryProposalResponse']>('POST', '/api/v1/memory/proposals', options, body);
  }

  confirmMemory(body: Schema['MemoryConfirmRequest'], options?: RequestOptions) {
    return this.request<Schema['MemoryConfirmationResponse']>('POST', '/api/v1/memory/confirm', options, body);
  }

  deleteMemory(id: string, options?: RequestOptions) {
    if (!identifier.test(id)) throw new TraceApiError('Invalid memory record identifier.', 'BAD_REQUEST');
    return this.request<Schema['MemoryDeletionResponse']>('DELETE', `/api/v1/memory/${id}`, options);
  }

  listProducts(query: Schema['ProductQuery'] = {}, options?: RequestOptions) {
    const params = new URLSearchParams();
    if (query.category) params.set('category', query.category);
    for (const id of query.ids ?? []) params.append('ids', id);
    return this.request<Schema['ProductCatalogResponse']>('GET', `/api/v1/products${params.size ? `?${params}` : ''}`, options);
  }

  getHealth(options?: RequestOptions) {
    return this.request<Schema['HealthResponse']>('GET', '/health', options);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE', path: string, options: RequestOptions = {}, body?: unknown,
  ): Promise<T> {
    if (options.signal?.aborted) throw new TraceApiError('Request cancelled.', 'CANCELLED');
    const headers = new Headers({ Accept: 'application/json' });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.requestId !== undefined) {
      if (!identifier.test(options.requestId)) throw new TraceApiError('Invalid request identifier.', 'BAD_REQUEST');
      headers.set('X-Request-Id', options.requestId);
    }
    if (path !== '/health') {
      const token = this.token();
      if (!token || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
        throw new TraceApiError('A valid bearer token is required.', 'UNAUTHENTICATED');
      }
      headers.set('Authorization', `Bearer ${token}`);
    }
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const response = await this.http(new URL(path, this.config.baseUrl), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      const invalid = () => new TraceApiError('Unexpected v1 API response or source.', 'BAD_RESPONSE', { status: response.status });
      if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw invalid();
      let value: unknown;
      try { value = await response.json(); } catch (error) {
        if (signal.aborted) throw error;
        throw invalid();
      }
      const payload = object(value);
      const meta = object(payload?.meta);
      if (!payload || meta?.apiVersion !== 'v1' || meta.source !== this.config.mode ||
          typeof meta.requestId !== 'string' || !identifier.test(meta.requestId)) throw invalid();
      if (!response.ok) {
        if (!failure(payload.error)) throw invalid();
        throw new TraceApiError(payload.error.message, payload.error.code, {
          status: response.status, requestId: meta.requestId, retryable: payload.error.retryable,
        });
      }
      if (!object(payload.data)) throw invalid();
      return value as T;
    } catch (error) {
      if (error instanceof TraceApiError) throw error;
      if (options.signal?.aborted) throw new TraceApiError('Request cancelled.', 'CANCELLED');
      if (deadline.aborted) throw new TraceApiError('Request timed out.', 'TIMEOUT');
      throw new TraceApiError('The TRACE API could not be reached.', 'NETWORK');
    }
  }
}
