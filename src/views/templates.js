import { escapeHtml } from "../utils/helpers.js";
import { REASONING_LEVELS } from "../config/constants.js";

export function renderHtml(state, providers) {
  const currentSelection = state.last_selection;

  let optionsHtml = "";
  for (const [pName, pInfo] of Object.entries(providers || {})) {
    for (const m of pInfo.models || []) {
      const value = `${pName}:${m.name}`;
      optionsHtml += `<option value="${escapeHtml(value)}"${
        value === currentSelection ? " selected" : ""
      }>${escapeHtml(m.name)}</option>`;
    }
  }

  let levelsHtml = "";
  for (const level of REASONING_LEVELS) {
    const selected = String(state.reasoning_level) === level.value ? " selected" : "";
    levelsHtml += `<option value="${level.value}"${selected}>${level.label}</option>`;
  }

  let messagesHtml = "";
  for (const msg of state.messages) {
    if (msg.role === "user") {
      messagesHtml += `<div class="msg-u">用户: ${msg.content}</div>`;
    } else {
      messagesHtml += `<div class="msg-b"><b>机器人:</b><br>${msg.content}`;
      if (msg.usage) {
        messagesHtml += `<div class="token-info">[Tokens: 输入 ${
          msg.usage.prompt || 0
        } | 补全 ${msg.usage.completion || 0} | 总计 ${msg.usage.total || 0}]</div>`;
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
      ${
        state.messages.length
          ? `<input type="submit" name="action" value="重发上次请求" style="width:100%; padding: 8px; margin-top:4px;">`
          : ""
      }
      <br><a href="/reset" style="display:block; margin-top:8px;"><small>[清空记录]</small></a>
    </p>
  </form>
</body>
</html>`;
}

export function renderLoadingHtml(state, providers) {
  const fullHtml = renderHtml(state, providers);
  const closeIdx = fullHtml.lastIndexOf("</body>");
  const base = closeIdx !== -1 ? fullHtml.slice(0, closeIdx) : fullHtml;

  return (
    base +
    '<div id="loading" style="margin:20px auto;text-align:center;color:#999;' +
    'font-family:sans-serif;font-size:14px;">' +
    "正在思考中，请稍候…" +
    "</div>"
  );
}

