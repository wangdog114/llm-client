import { DEFAULT_SELECTION_FALLBACK, COOKIE_NAME, SYSTEM_PROMPT } from "./config/constants.js";
import { escapeHtml, getProviders } from "./utils/helpers.js";
import { getCookie, createSessionId, setSessionCookie } from "./utils/cookie.js";
import { renderMarkdownWithLatex } from "./utils/markdown.js";
import { loadOrCreateSession, saveSession } from "./db/session.js";
import { parseModelSelection, getModelConfig } from "./providers/utils.js";
import { createProviderCompletion } from "./providers/index.js";
import { renderHtml, renderLoadingHtml } from "./views/templates.js";

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.DB) {
        return new Response("D1 binding 'DB' is not configured", { status: 500 });
      }

      const url = new URL(request.url);
      const providers = getProviders(env);
      const sessionId = getCookie(request, COOKIE_NAME) || createSessionId();
      const state = await loadOrCreateSession(env, sessionId);
      const cookieHeader = setSessionCookie(sessionId);

      // 路由 1: 重置历史记录
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

      // 路由 2: 处理发送消息 (POST)
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
          const safeUserText = escapeHtml(userText).replace(/\n/g, "<br>");
          
          if (action !== "重发上次请求") {
            state.messages.push({
              role: "user",
              content: safeUserText,
              raw_content: userText,
            });
          }
          await saveSession(env, sessionId, state);

          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              // 1. 发送正在思考状态
              const loadingHtml = renderLoadingHtml(state, providers);
              controller.enqueue(encoder.encode(loadingHtml));

              // 2. 维持长连接的心跳包，防止 Cloudflare 524 超时
              const heartbeat = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode("<!-- keepalive -->\n"));
                } catch (_) {
                  clearInterval(heartbeat);
                }
              }, 15000);

              try {
                const [providerName, modelName] = parseModelSelection(selected);
                const providerInfo = providers[providerName];
                if (!providerInfo) throw new Error(`Provider ${providerName} not found.`);
                const modelInfo = getModelConfig(providerInfo, modelName);

                const apiResult = await createProviderCompletion(
                  providerName,
                  providerInfo,
                  modelInfo,
                  modelName,
                  SYSTEM_PROMPT,
                  chatHistory,
                  userText,
                  reasoningLevel,
                  env
                );

                const clientSupportsSvg = getCookie(request, "svg_supported") === "1";
                const botHtmlFinal = await renderMarkdownWithLatex(
                  apiResult.text,
                  clientSupportsSvg
                );

                state.messages.push({
                  role: "assistant",
                  content: botHtmlFinal,
                  raw_content: apiResult.text,
                  usage: apiResult.usage,
                });
                await saveSession(env, sessionId, state);
              } catch (err) {
                const errorMessage = err.message || String(err);
                state.messages.push({
                  role: "assistant",
                  content: `<b>ERROR:</b> ${escapeHtml(errorMessage)}`,
                  raw_content: errorMessage,
                });
                await saveSession(env, sessionId, state);
              } finally {
                clearInterval(heartbeat);
              }

              // 3. 发送 meta 刷新标记并闭合 HTML
              const ending = '<meta http-equiv="refresh" content="0"></body></html>';
              controller.enqueue(encoder.encode(ending));
              controller.close();
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Set-Cookie": cookieHeader,
            },
          });
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

      // 路由 3: 渲染页面 (GET)
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

