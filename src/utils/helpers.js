export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function withRetry(fn, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isD1Error = err.message && err.message.includes("D1_ERROR");
      if (isD1Error && i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(2, i)));
        continue;
      }
      throw err;
    }
  }
}

export function getProviders(env) {
  if (!env.PROVIDERS) return {};
  if (typeof env.PROVIDERS === "string") return JSON.parse(env.PROVIDERS);
  return env.PROVIDERS;
}

