/** 短时缓存:同一份数据在一次页面加载里会被多个模块要,几秒内复用,并发请求合并成一次 */
const store = new Map<string, { at: number; p: Promise<unknown> }>();
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = fn().catch(e => { store.delete(key); throw e; });
  store.set(key, { at: Date.now(), p });
  return p;
}
export const invalidate = (prefix: string) => { for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k); };
