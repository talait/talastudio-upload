import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';

/** One database client per request (Workers may not share a connection across requests), through Hyperdrive (role ts_app). */
export type Env = {
  HYPERDRIVE_APP: { connectionString: string };
  GITHUB_REPO?: string;
  GOOGLE_SA_KEY?: string;
  /** Supabase project URL for the REST API (wrangler.jsonc var). */
  SUPABASE_URL?: string;
  /** Supabase secret key (sb_secret_…) for the REST API; dashboard secret. Without it /api/feed stays on Hyperdrive. */
  SUPABASE_SECRET_KEY?: string;
};

/**
 * The history feed over the Supabase REST API instead of Hyperdrive (27 Nov 2026): the app polls it every few seconds
 * from every PC, which used up the Workers Free plan's 100,000 Hyperdrive queries per day. POST, because the feed
 * updates the device's last_seen_at and PostgREST runs GET read-only. Errors keep the database code (28000 = unknown
 * device) so dbError() answers exactly as on the Hyperdrive path.
 */
export async function restFeed(env: Env, token: string, since: string | null): Promise<unknown> {
  const res = await fetch(`${env.SUPABASE_URL!.replace(/\/+$/, '')}/rest/v1/rpc/filedrop_feed`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SECRET_KEY!, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ p_token: token, p_since: since }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (res.ok) return body;
  const e = (body ?? {}) as { code?: string; message?: string };
  // PostgREST errors from the database carry the SQLSTATE in `code`; gateway errors (bad key, outage) do not.
  if (e.code && /^[0-9A-Z]{5}$/.test(e.code)) throw Object.assign(new Error(e.message ?? 'Database error'), { code: e.code });
  throw new Error(`Supabase REST ${res.status}: ${(e.message ?? text).slice(0, 160)}`);
}
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
