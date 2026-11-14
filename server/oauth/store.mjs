/** DEVELOPMENT ONLY. Production supplies an encrypted shared store with atomic consume/locks. */
export function createDevelopmentMemoryStore({ now = Date.now, maximumEntries = 1000 } = {}) {
  const values = new Map(), locks = new Map();
  const read = key => {
    const row = values.get(key);
    if (row && row.expiresAt <= now()) { values.delete(key); return undefined; }
    return row ? structuredClone(row.value) : undefined;
  };
  return Object.freeze({
    kind: 'development-memory', productionReady: false,
    async get(key) { return read(key); },
    async set(key, value, expiresAt) {
      for (const [id, row] of values) if (row.expiresAt <= now()) values.delete(id);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error('Invalid store expiry.');
      if (!values.has(key) && values.size >= maximumEntries) throw new Error('Development session store is full.');
      values.set(key, { value: structuredClone(value), expiresAt });
    },
    async delete(key) { values.delete(key); },
    async consume(key) { const value = read(key); values.delete(key); return value; },
    async withLock(key, operation) {
      const previous = locks.get(key) ?? Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      locks.set(key, current);
      await previous.catch(() => {});
      try { return await operation(); }
      finally { release(); if (locks.get(key) === current) locks.delete(key); }
    },
  });
}
