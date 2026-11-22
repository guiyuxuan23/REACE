const PROPOSAL_LIFETIME_MS = 5 * 60_000;
const OBSERVATION_WINDOW_MS = 30_000;
const MAX_STATE = 256;

export class ApiFault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireCapacity(store) {
  if (store.size >= MAX_STATE) throw new ApiFault(503, 'Development fixture capacity reached. Restart the mock.');
}

export function createScenarios(clock, example, randomUUID) {
  const sessions = new Set();
  const turns = new Map();
  const proposals = new Map();
  const confirmed = new Map();
  const deleted = new Set();
  const products = example('ProductCatalogResponse').data.items;

  function requireSession(id) {
    if (id && !sessions.has(id)) throw new ApiFault(404, 'Session not found.');
  }

  return {
    agent(input) {
      const { requestId, sessionId, locale, message } = input;
      const signature = JSON.stringify([sessionId ?? null, locale, message.text]);
      const turn = turns.get(requestId);
      if (turn) {
        if (turn.signature !== signature) throw new ApiFault(409, 'This turn identifier was used with different input.');
        return turn.data;
      }
      requireSession(sessionId);
      requireCapacity(turns);
      if (!sessionId) requireCapacity(sessions);
      const id = sessionId ?? randomUUID();
      sessions.add(id);
      const data = example('AgentMessageResponse').data;
      data.session.id = id;
      data.session.locale = locale;
      if (locale === 'en') {
        data.content = { speech: 'Development mock received text.', display: { text: 'Development mock. This is a fixed response.' } };
      }
      turns.set(requestId, { signature, data });
      return data;
    },

    vision(input) {
      requireSession(input.sessionId);
      if (!input.authorization.granted) throw new ApiFault(403, 'This local observation was not authorized.');
      const age = clock() - Date.parse(input.observation.capturedAt);
      if (age > OBSERVATION_WINDOW_MS || age < -5_000) throw new ApiFault(409, 'Capture time is outside the accepted window.');
      const data = example('VisionAnalysisResponse').data;
      data.task = input.task;
      return data;
    },

    profile() {
      return { records: [...confirmed.values()] };
    },

    propose(input) {
      const now = clock();
      for (const [id, item] of proposals) {
        if (!item.receipt && item.deadline <= now) proposals.delete(id);
      }
      if (input.operation === 'correct') {
        const record = confirmed.get(input.memoryId);
        if (!record) throw new ApiFault(404, 'Memory record not found.');
        if (record.version !== input.expectedVersion) throw new ApiFault(409, 'Memory version changed. Refresh it before reviewing.');
      }
      requireCapacity(proposals);
      const id = randomUUID();
      const deadline = now + PROPOSAL_LIFETIME_MS;
      const data = { id, version: 1, operation: input.operation, memoryId: input.memoryId ?? null, preference: input.preference, expiresAt: new Date(deadline).toISOString() };
      proposals.set(id, { data, deadline, recordVersion: input.expectedVersion });
      return data;
    },

    confirm(input) {
      if (!input.confirmed) throw new ApiFault(403, 'Explicit confirmation is required.');
      const entry = proposals.get(input.proposalId);
      if (!entry) throw new ApiFault(404, 'Memory proposal not found.');
      if (input.expectedVersion !== entry.data.version || entry.revoked) throw new ApiFault(409, 'Refresh the proposal before confirming.');
      if (entry.receipt) return entry.receipt;
      if (entry.deadline <= clock()) throw new ApiFault(409, 'The proposal expired. Review a new one.');
      const { memoryId, preference } = entry.data;
      const old = confirmed.get(memoryId);
      if (memoryId && old?.version !== entry.recordVersion) throw new ApiFault(409, 'The reviewed record changed or was deleted.');
      if (!memoryId) requireCapacity(confirmed);
      const data = { id: memoryId ?? randomUUID(), version: old ? old.version + 1 : 1, preference };
      confirmed.set(data.id, data);
      entry.receipt = data;
      return data;
    },

    delete(id) {
      if (!deleted.has(id)) {
        if (!confirmed.has(id)) throw new ApiFault(404, 'Memory record not found.');
        confirmed.delete(id);
        deleted.add(id);
        for (const entry of proposals.values()) {
          if (entry.data.memoryId === id || entry.receipt?.id === id) entry.revoked = true;
        }
      }
      return { id, status: 'deleted' };
    },

    products({ category, ids }) {
      const ordered = ids ? ids.flatMap(id => products.filter(product => product.id === id)) : products;
      return { items: ordered.filter(product => !category || product.category === category) };
    },

    health() {
      return example('HealthResponse').data;
    },
  };
}
