import { withRetry } from "../utils/helpers.js";
import { DEFAULT_SELECTION_FALLBACK, SESSION_TTL_MS, MAX_MESSAGES_HISTORY } from "../config/constants.js";

let ensureTablePromise = null;

export async function ensureTable(env) {
  if (!ensureTablePromise) {
    ensureTablePromise = withRetry(() =>
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )`
      ).run()
    )
      .then(() => true)
      .catch((err) => {
        ensureTablePromise = null;
        throw err;
      });
  }
  return ensureTablePromise;
}

export function normalizeState(raw, env) {
  return {
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    last_selection:
      raw?.last_selection || env.DEFAULT_SELECTION || DEFAULT_SELECTION_FALLBACK,
    use_ctx: raw?.use_ctx !== false,
    reasoning_level: raw?.reasoning_level ?? "0",
  };
}

export function defaultSessionState(env) {
  return normalizeState(null, env);
}

export async function loadSession(env, id) {
  await ensureTable(env);
  const row = await withRetry(() =>
    env.DB.prepare(
      `SELECT data FROM sessions WHERE id = ? AND expires_at > ?`
    )
      .bind(id, Date.now())
      .first()
  );
  return row ? normalizeState(JSON.parse(row.data), env) : null;
}

export async function saveSession(env, id, state) {
  await ensureTable(env);
  if (state.messages.length > MAX_MESSAGES_HISTORY) {
    state.messages = state.messages.slice(-MAX_MESSAGES_HISTORY);
  }
  await withRetry(() =>
    env.DB.prepare(
      `INSERT INTO sessions (id, data, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
    )
      .bind(id, JSON.stringify(state), Date.now() + SESSION_TTL_MS)
      .run()
  );
}

export async function loadOrCreateSession(env, id) {
  const existing = await loadSession(env, id);
  if (existing) return existing;
  const fresh = defaultSessionState(env);
  await saveSession(env, id, fresh);
  return fresh;
}

