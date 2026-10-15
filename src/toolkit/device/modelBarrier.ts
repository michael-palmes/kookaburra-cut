const settled = new Map<string, Promise<void>>();

/** Runs a model barrier's fetch + parse once per key for the life of the realm: later preambles (every bridge frame, a verify's second pass) resolve at once instead of re-parsing every glb. A failure evicts its key, so the next barrier retries. */
export function modelBarrierOnce(key: string, load: () => Promise<void>): Promise<void> {
  const existing = settled.get(key);
  if (existing) return existing;
  const pending = load();
  settled.set(key, pending);
  pending.catch(() => settled.delete(key));
  return pending;
}
