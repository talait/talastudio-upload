import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';

/** One database client per request (Workers may not share a connection across requests), through Hyperdrive (role ts_app). */
export type Env = { HYPERDRIVE_APP: { connectionString: string }; GITHUB_REPO?: string; GOOGLE_SA_KEY?: string };
type Store = { env: Env; app?: postgres.Sql };
export const requestStore = new AsyncLocalStorage<Store>();

const opts = { max: 3, fetch_types: false, prepare: false, idle_timeout: 5, connect_timeout: 10 } as const;
function client(): postgres.Sql {
  const s = requestStore.getStore();
  if (!s) throw new Error('Database used outside a request');
  return (s.app ??= postgres(s.env.HYPERDRIVE_APP.connectionString, opts));
}

export const sql = new Proxy(function () { /* target only */ } as unknown as postgres.Sql, {
  apply: (_t, _this, args: unknown[]) => (client() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_t, p) => {
    const c = client() as unknown as Record<string | symbol, unknown>;
    const v = c[p];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});

export async function closeClient(s: Store) {
  await s.app?.end({ timeout: 5 }).catch(() => undefined);
}

/** Call a filedrop.* function that returns one jsonb/bytea value. Hyperdrive does not convert arrays, so only scalars go in. */
export async function one<T>(q: Promise<unknown>): Promise<T> {
  const rows = (await q) as unknown as { r: unknown }[];
  const r = rows[0]?.r;
  return (typeof r === 'string' && (r.startsWith('{') || r.startsWith('[')) ? JSON.parse(r) : r) as T;
}
