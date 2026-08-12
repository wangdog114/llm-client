import { marked } from "marked";

marked.use({ breaks: true, gfm: true });

const DEFAULT_SELECTION_FALLBACK = "OpenAI:gpt-5.4-mini";
const COOKIE_NAME = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const REASONING_LEVELS = [
  { value: "0", label: "最低" },
  { value: "1", label: "低" },
  { value: "2", label: "中" },
  { value: "3", label: "高" },
];

let ensureTablePromise = null;

function ensureTable(env) {
  if (!ensureTablePromise) {
    ensureTablePromise = env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`
    )
      .run()
      .then(() => true)
      .catch((err) => {
        ensureTablePromise = null;
        throw err;
      });
  }
  return ensureTablePromise;
}

function normalizeState(raw, env) {
  return {
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    last_selection:
      raw?.last_selection || env.DEFAULT_SELECTION || DEFAULT_SELECTION_FALLBACK,
    use_ctx: raw?.use_ctx !== false,
    reasoning_level: raw?.reasoning_level ?? "0",
  };
}

function defaultSessionState(env) {
  return normalizeState(null, env);
}

function getProviders(env) {
  if (!env.PROVIDERS) return {};
  if (typeof env.PROVIDERS === "string") return JSON.parse(env.PROVIDERS);
  return env.PROVIDERS;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

function createSessionId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function setSessionCookie(id) {
  return `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}`;
}

async function saveSession(env, id, state) {
  await ensureTable(env);
  await env.DB.prepare(
    `INSERT INTO sessions (id, data, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
  )
    .bind(id, JSON.stringify(state), Date.now() + SESSION_TTL_MS)
    .run();
}

async function loadSession(env, id) {
  await ensureTable(env);
  const row = await env.DB.prepare(
    `SELECT data FROM sessions WHERE id = ? AND expires_at > ?`
  )
    .bind(id, Date.now())
    .first();
  return row ? normalizeState(JSON.parse(row.data), env) : null;
}

async function loadOrCreateSession(env, id) {
  const existing = await loadSession(env, id);
  if (existing) return existing;
  const fresh = defaultSessionState(env);
  await saveSession(env, id, fresh);
  return fresh;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseModelSelection(selection) {
  if (!selection) return ["OpenAI", "gpt-5.4-nano"];
  const idx = selection.indexOf(":");
  if (idx === -1) return ["OpenAI", selection];
  return [selection.slice(0, idx), selection.slice(idx + 1)];
}

function getModelConfig(providerInfo, modelName) {
  return (providerInfo.models || []).find((m) => m.name === modelName) || null;
}

function getReasoningEffort(providerInfo, modelName, reasoningLevel) {
  const modelInfo = getModelConfig(providerInfo, modelName);
  if (!modelInfo) return null;

  const values =
    modelInfo.reasoning_effort ??
    modelInfo.reasoningEffort ??
    providerInfo.reasoning_effort ??
    providerInfo.reasoningEffort;

  if (!Array.isArray(values)) return null;

  const idx = parseInt(reasoningLevel, 10);
  if (isNaN(idx) || idx < 0 || idx >= values.length) return null;

  return values[idx];
}

function getProviderType(providerName, providerInfo) {
  if (providerInfo.type) return providerInfo.type;

  const name = providerName.toLowerCase();
  const base = String(providerInfo.base_url || providerInfo.baseUrl || "").toLowerCase();

  if (name.includes("anthropic") || base.includes("anthropic.com")) return "anthropic";
  if (
    name.includes("google") ||
    name.includes("gemini") ||
    base.includes("generativelanguage")
  ) {
    return "google";
  }
  return "openai";
}

function buildGoogleContents(chatHistory, userText) {
  const contents = [];

  for (const message of chatHistory) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const role = message.role === "assistant" ? "model" : "user";
    contents.push({
      role,
      parts: [{ text: message.raw_content || message.content }],
    });
  }

  contents.push({ role: "user", parts: [{ text: userText }] });
  return contents;
}

async function createOpenAICompletion(
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel
) {
  const apiKey =
    modelInfo?.api_key ||
    modelInfo?.apiKey ||
    providerInfo.api_key ||
    providerInfo.apiKey;

  if (!apiKey) throw new Error("No API key for OpenAI-compatible provider.");

  const baseUrl = String(
    providerInfo.base_url || providerInfo.baseUrl || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");

  const webSearchEnabled =
    modelInfo?.web_search ??
    modelInfo?.webSearch ??
    providerInfo.web_search ??
    providerInfo.webSearch ??
    false;

  const input = [];
  for (const m of chatHistory) {
    if (m.role === "user" || m.role === "assistant") {
      input.push({
        role: m.role,
        content: m.raw_content || m.content,
      });
    }
  }
  input.push({ role: "user", content: userText });

  const body = {
    model: modelName,
    input,
  };

  if (systemPrompt) {
    body.instructions = systemPrompt;
  }

  if (webSearchEnabled) {
    body.tools = [{ type: "web_search" }];
  }

  const reasoningEffort = getReasoningEffort(
    providerInfo,
    modelName,
    reasoningLevel
  );
  if (reasoningEffort != null && reasoningEffort !== "") {
    body.reasoning = { effort: reasoningEffort };
  }

  const resp = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body: JSON.stringify(body),
  });

  const responseText = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI API error ${resp.status}: ${responseText}`);
  }

  const data = JSON.parse(responseText);

  const output = data.output || [];
  let finalText = "";
  for (let i = output.length - 1; i >= 0; i--) {
    const item = output[i];
    if (item.type === "message") {
      const textParts = (item.content || [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text || "");
      if (textParts.length > 0) {
        finalText = textParts.join("");
        break;
      }
    }
  }

  const usage = data.usage
    ? {
      prompt: data.usage.input_tokens || 0,
      completion: data.usage.output_tokens || 0,
      total: data.usage.total_tokens || 0,
    }
    : null;

  return { text: finalText, usage };
}

async function createAnthropicCompletion(
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel,
  env
) {
  const apiKey =
    modelInfo?.api_key ||
    modelInfo?.apiKey ||
    providerInfo.api_key ||
    providerInfo.apiKey;

  if (!apiKey) throw new Error("No API key for Anthropic provider.");

  const baseUrl = String(
    providerInfo.base_url || providerInfo.baseUrl || "https://api.anthropic.com"
  ).replace(/\/+$/, "");

  const messages = [];

  for (const m of chatHistory) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.raw_content || m.content });
    }
  }
  messages.push({ role: "user", content: userText });

  const maxTokens =
    modelInfo?.max_tokens ||
    providerInfo.max_tokens ||
    env?.ANTHROPIC_MAX_TOKENS ||
    8000;

  const body = {
    model: modelName,
    max_tokens: maxTokens,
    messages,
  };

  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const reasoningEffort = getReasoningEffort(
    providerInfo,
    modelName,
    reasoningLevel
  );
  if (reasoningEffort != null && reasoningEffort !== "") {
    body.output_config = { effort: reasoningEffort };
  }

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version":
        providerInfo.anthropic_version || env?.ANTHROPIC_VERSION || "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const responseText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Anthropic API error ${resp.status}: ${responseText}`);
  }

  const data = JSON.parse(responseText);

  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("");

  const promptTokens = data.usage?.input_tokens || 0;
  const thinkingTokens = data.usage?.output_tokens_details?.thinking_tokens || 0;
  const completionTokens = (data.usage?.output_tokens || 0) + thinkingTokens;

  const usage = data.usage
    ? {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens,
    }
    : null;

  return { text, usage };
}

async function createGoogleGroundedCompletion(
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel,
  googleSearchEnabled,
  supportsThinking
) {
  const apiKey =
    modelInfo?.genai_api_key ||
    modelInfo?.genaiApiKey ||
    providerInfo.genai_api_key ||
    providerInfo.genaiApiKey ||
    providerInfo.api_key ||
    providerInfo.apiKey;

  if (!apiKey) throw new Error("No API key for Google provider.");

  const genaiModel = modelInfo?.genai_model || modelInfo?.genaiModel || modelName;

  const baseUrl = String(
    providerInfo.base_url ||
    providerInfo.baseUrl ||
    "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: buildGoogleContents(chatHistory, userText),
  };

  if (googleSearchEnabled) {
    body.tools = [{ google_search: {}, url_context: {} }];
  }

  if (supportsThinking) {
    const thinkingLevel = getReasoningEffort(
      providerInfo,
      modelName,
      reasoningLevel
    );

    if (thinkingLevel != null && thinkingLevel !== "") {
      body.generationConfig = {
        thinkingConfig: { thinkingLevel },
      };
    }
  }

  const url = `${baseUrl}/models/${encodeURIComponent(
    genaiModel
  )}:generateContent`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const responseText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Google API error ${resp.status}: ${responseText}`);
  }

  const data = JSON.parse(responseText);

  const text =
    (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("") || "";

  const usageMeta = data.usageMetadata;

  const promptTokens = usageMeta?.promptTokenCount || 0;
  const completionTokens =
    (usageMeta?.candidatesTokenCount || 0) + (usageMeta?.thoughtsTokenCount || 0);

  const usage = usageMeta
    ? {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens,
    }
    : null;

  return { text, usage };
}

async function createProviderCompletion(
  providerName,
  providerInfo,
  modelInfo,
  modelName,
  systemPrompt,
  chatHistory,
  userText,
  reasoningLevel,
  env
) {
  const type = getProviderType(providerName, providerInfo);

  if (type === "anthropic") {
    return createAnthropicCompletion(
      providerInfo,
      modelInfo,
      modelName,
      systemPrompt,
      chatHistory,
      userText,
      reasoningLevel
    );
  }

  if (type === "google") {
    const googleSearchEnabled =
      modelInfo?.google_search ??
      modelInfo?.googleSearch ??
      providerInfo.google_search ??
      providerInfo.googleSearch ??
      false;

    const supportsThinking =
      modelInfo?.supports_thinking ??
      modelInfo?.supportsThinking ??
      true;

    return createGoogleGroundedCompletion(
      providerInfo,
      modelInfo,
      modelName,
      systemPrompt,
      chatHistory,
      userText,
      reasoningLevel,
      googleSearchEnabled,
      supportsThinking
    );
  }

  return createOpenAICompletion(
    providerInfo,
    modelInfo,
    modelName,
    systemPrompt,
    chatHistory,
    userText,
    reasoningLevel
  );
}

function makeLatexImg(mathCode, isSvg, type) {
  const fmt = isSvg ? "svg" : "gif";
  const prefix = String.raw`\dpi{110}\bg_white\space `;
  const src = `https://latex.codecogs.com/${fmt}.image?${encodeURIComponent(
    prefix + mathCode
  )}`;
  if (type === "block") {
    return `<br><img src="${src}" style="max-width:100%; border:none;" alt="Math block"><br>`;
  }
  return `<img src="${src}" style="vertical-align: middle; max-width:100%; border:none;" alt="Math inline">`;
}
function processLatexToPlaceholders(text, isSvg) {
  const placeholders = [];
  const placeholderBase = "%%LATEX_PLACEHOLDER_";
  text = String(text || "").replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => {
    const index = placeholders.length;
    placeholders.push(makeLatexImg(math.trim(), isSvg, "block"));
    return `${placeholderBase}${index}%%`;
  });
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => {
    const index = placeholders.length;
    placeholders.push(makeLatexImg(math.trim(), isSvg, "inline"));
    return `${placeholderBase}${index}%%`;
  });
  return { text, placeholders };
}
function restoreLatexPlaceholders(html, placeholders) {
  placeholders.forEach((imgTag, index) => {
    html = html.replace(`${"%%LATEX_PLACEHOLDER_"}${index}%%`, imgTag);
  });
  return html;
}


function renderHtml(state, providers) {
  const currentSelection = state.last_selection;

  let optionsHtml = "";
  for (const [pName, pInfo] of Object.entries(providers || {})) {
    for (const m of pInfo.models || []) {
      const value = `${pName}:${m.name}`;
      optionsHtml += `<option value="${escapeHtml(value)}"${value === currentSelection ? " selected" : ""
        }>${escapeHtml(m.name)}</option>`;
    }
  }

  let levelsHtml = "";
  for (const level of REASONING_LEVELS) {
    const selected =
      String(state.reasoning_level) === level.value ? " selected" : "";
    levelsHtml += `<option value="${level.value}"${selected}>${level.label}</option>`;
  }

  let messagesHtml = "";
  for (const msg of state.messages) {
    if (msg.role === "user") {
      messagesHtml += `<div class="msg-u">用户: ${msg.content}</div>`;
    } else {
      messagesHtml += `<div class="msg-b"><b>机器人:</b><br>${msg.content}`;
      if (msg.usage) {
        messagesHtml += `<div class="token-info">[Tokens: 输入 ${msg.usage.prompt || 0
          } | 补全 ${msg.usage.completion || 0} | 总计 ${msg.usage.total || 0
          }]</div>`;
      }
      messagesHtml += `</div>`;
    }
  }

  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="HandheldFriendly" content="true">
  <meta name="MobileOptimized" content="320">
  <title>AI Terminal</title>
  <script type="text/javascript">
    try {
      var svgSupported = !!document.createElementNS && !!document.createElementNS('http://www.w3.org/2000/svg', 'svg').createSVGRect;
      document.cookie = "svg_supported=" + (svgSupported ? "1" : "0") + "; path=/; max-age=2592000";
    } catch (e) { }
  </script>
  <style type="text/css">
    * { box-sizing: border-box; -moz-box-sizing: border-box; -webkit-box-sizing: border-box; }
    body { font-family: sans-serif; font-size: 14px; background: #fff; margin: 5px; }
    input, select, textarea { font-size: 100%; font-family: inherit; max-width: 100%; }
    .msg-u { color: #0000AA; font-weight: bold; margin: 8px 0; }
    .msg-b { background: #F0F0F0; border-left: 3px solid #ccc; padding: 4px 8px; margin: 8px 0; }
    .cfg { background: #EEE; padding: 5px; border: 1px solid #CCC; }
    img { max-width: 100%; height: auto; }
    .token-info { color: #666666; font-size: 11px; border-top: 1px dashed #cccccc; margin-top: 5px; padding-top: 3px; }
    table { border-collapse: collapse; margin: 10px 0; width: 100%; max-width: 100%; }
    th, td { border: 1px solid #999999; padding: 4px 8px; text-align: left; }
    th { background-color: #E0E0E0; }
    pre { background: #E8E8E8; padding: 8px; border: 1px solid #CCC; overflow-x: auto; font-family: monospace; white-space: pre-wrap; word-wrap: break-word; }
    code { font-family: monospace; background: #E8E8E8; padding: 1px 3px; }
    .msg-b p { margin: 5px 0; }
  </style>
</head>
<body>
  <form action="/" method="post">
    <div class="cfg">
      模型:
      <select name="model_selection" id="model_selection">
        ${optionsHtml}
      </select><br>
      推理强度:
      <select name="reasoning_level" id="reasoning_level">
        ${levelsHtml}
      </select>
      <input type="checkbox" name="use_ctx" value="on" ${state.use_ctx ? "checked" : ""}>启用上下文
    </div>

    <div id="chat">
      ${messagesHtml}
    </div>

    <p>
      <b>输入:</b><br>
      <textarea name="content" rows="3" style="width:100%"></textarea><br>
      <input type="submit" value="发送消息 (等待刷新)" style="width:100%; padding: 8px;">
      ${state.messages.length
      ? `<input type="submit" name="action" value="重发上次请求" style="width:100%; padding: 8px; margin-top:4px;">`
      : ""
    }
      <br><a href="/reset" style="display:block; margin-top:8px;"><small>[清空记录]</small></a>
    </p>
  </form>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.DB) {
        return new Response("D1 binding 'DB' is not configured", {
          status: 500,
        });
      }

      const url = new URL(request.url);
      const providers = getProviders(env);
      const sessionId = getCookie(request, COOKIE_NAME) || createSessionId();
      const state = await loadOrCreateSession(env, sessionId);
      const cookieHeader = setSessionCookie(sessionId);

      if (url.pathname === "/reset") {
        state.messages = [];
        await saveSession(env, sessionId, state);
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie": cookieHeader,
            "Cache-Control": "no-store",
          },
        });
      }

      if (url.pathname !== "/") {
        return new Response("Not Found", { status: 404 });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const action = form.get("action") || "send";
        const selected =
          form.get("model_selection") ||
          state.last_selection ||
          env.DEFAULT_SELECTION ||
          DEFAULT_SELECTION_FALLBACK;
        const useCtx = form.get("use_ctx") === "on";
        const reasoningLevel =
          form.get("reasoning_level") ?? state.reasoning_level ?? "0";

        state.last_selection = selected;
        state.use_ctx = useCtx;
        state.reasoning_level = reasoningLevel;

        let userText;

        if (action === "重发上次请求") {
          for (let i = state.messages.length - 1; i >= 0; i--) {
            if (state.messages[i].role === "user") {
              userText = state.messages[i].raw_content || state.messages[i].content;
              break;
            }
          }
        } else {
          userText = (form.get("content") || "").trim();
        }

        if (userText) {
          const chatHistory = useCtx ? state.messages.slice(-10) : [];

          const systemPrompt =
            "You are a helpful assistant.\n" +
            "FORMATTING RULES:\n" +
            "1. TEXT & TABLES:\n" +
            "   - Use plain text only. No MathML or complex raw HTML tables. No emoji.\n" +
            "   - Do NOT use tables for simple lists or regular text.\n" +
            "   - Use standard Markdown tables (using | and -) ONLY if explicitly requested or for presenting highly structured comparative data.\n\n" +
            "2. MATH & LATEX USAGE:\n" +
            "   - Use LaTeX ONLY if the conversation strictly involves mathematics or formulas. Do not force equations into casual conversations.\n\n" +
            "3. LATEX DELIMITERS (CRITICAL):\n" +
            "   - Inline math: MUST use \\\\( and \\\\) (e.g., \\\\(x^2\\\\)). NEVER use single dollar signs $...$.\n" +
            "   - Block math: MUST use \\\\[ and \\\\] (e.g., \\\\[y = mx + b\\\\]). NEVER use double dollar signs $$...$$.\n\n" +
            "4. LATEX CONTENT RESTRICTION (CRITICAL):\n" +
            "   - LaTeX delimiters must ONLY contain standard ASCII characters (numbers, basic math symbols, English variables).\n" +
            "   - NEVER put Chinese or any other non-ASCII characters inside LaTeX delimiters (such as \\\\(...\\\\) or \\\\[...\\\\]).\n" +
            "   - Do NOT use \\\\text{...} to wrap Chinese characters inside LaTeX.\n" +
            "   - All Chinese explanations and text must be placed OUTSIDE the LaTeX delimiters.\n" +
            "     * Correct: \"因此我们可以得到 \\\\(x = 2\\\\) 这一结果。\"\n" +
            "     * Incorrect: \"\\\\(因此我们可以得到 x = 2 这一结果。\\\\)\" or \"\\\\(x = 2 \\\\text{ (个)}\\\\)\"\n";

          const safeUserText = escapeHtml(userText).replace(/\n/g, "<br>");

          if (action !== "重发上次请求") {
            state.messages.push({
              role: "user",
              content: safeUserText,
              raw_content: userText,
            });
          }

          try {
            const [providerName, modelName] = parseModelSelection(selected);
            const providerInfo = providers[providerName];

            if (!providerInfo) {
              throw new Error(`Provider ${providerName} not found.`);
            }

            const modelInfo = getModelConfig(providerInfo, modelName);

            const apiResult = await createProviderCompletion(
              providerName,
              providerInfo,
              modelInfo,
              modelName,
              systemPrompt,
              chatHistory,
              userText,
              reasoningLevel,
              env
            );

            const clientSupportsSvg = getCookie(request, "svg_supported") === "1";
            const { text: textWithPlaceholders, placeholders } = processLatexToPlaceholders(
              apiResult.text,
              clientSupportsSvg
            );
            const botHtml = await marked.parse(textWithPlaceholders);
            const botHtmlFinal = restoreLatexPlaceholders(botHtml, placeholders);
            state.messages.push({
              role: "assistant",
              content: botHtmlFinal,
              raw_content: apiResult.text,
              usage: apiResult.usage,
            });
          } catch (err) {
            const errorMessage = err.message || String(err);
            state.messages.push({
              role: "assistant",
              content: `<b>ERROR:</b> ${escapeHtml(errorMessage)}`,
              raw_content: errorMessage,
            });
          }
        }

        await saveSession(env, sessionId, state);

        return new Response(null, {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie": cookieHeader,
            "Cache-Control": "no-store",
          },
        });
      }

      if (request.method === "GET") {
        return new Response(renderHtml(state, providers), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Set-Cookie": cookieHeader,
          },
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    } catch (err) {
      return new Response(`Internal Error: ${escapeHtml(err.message || err)}`, {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  },
};

