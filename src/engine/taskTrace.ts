const trace = new Map<string, [number, number, number]>();
let on = false;

export function setTaskTrace(enabled: boolean): void {
  on = enabled;
  trace.clear();
}

export function noteTask(kind: string, ms: number): void {
  if (!on) return;
  const row = trace.get(kind) ?? [0, 0, 0];
  row[0] += 1;
  row[1] += ms;
  row[2] = Math.max(row[2], ms);
  trace.set(kind, row);
}

export function traced<T>(kind: string, fn: () => T): T {
  if (!on) return fn();
  const at = performance.now();
  try {
    return fn();
  } finally {
    noteTask(kind, performance.now() - at);
  }
}

export async function tracedWait<T>(kind: string, wait: Promise<T>): Promise<T> {
  if (!on) return wait;
  const at = performance.now();
  try {
    return await wait;
  } finally {
    noteTask(kind, performance.now() - at);
  }
}

export function takeTaskTrace(): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const [kind, [n, ms, max]] of trace) out[kind] = [n, Math.round(ms), Math.round(max)];
  trace.clear();
  return out;
}
