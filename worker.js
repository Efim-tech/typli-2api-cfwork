/**
 * =================================================================================
 * 项目: typli-2api (Cloudflare Worker 单文件版)
 * 版本: 2.3.0 (代号: Chimera Vision - CSRF Fix + Dual Format Parser)
 *
 * [核心特性]
 * 1. [CSRF 修复] 正确获取并使用 CSRF Token，解决 403 错误
 * 2. [双格式解析] 同时支持旧版 (text-delta) 和新版 (text-delta + reasoning-delta) SSE 格式
 * 3. [无限续杯] 每次请求自动生成全新 Session ID
 * 4. [OpenAI 兼容] 完美转换为标准 API 格式
 * =================================================================================
 */

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "typli-2api",
  PROJECT_VERSION: "2.3.0",

  API_MASTER_KEY: "1",

  UPSTREAM_CHAT_URL: "https://typli.ai/api/generators/chat",
  UPSTREAM_IMAGE_URL: "https://typli.ai/api/generators/images",
  ORIGIN_URL: "https://typli.ai",
  REFERER_CHAT_URL: "https://typli.ai/free-no-sign-up-chatgpt",
  REFERER_IMAGE_URL: "https://typli.ai/ai-image-generator",

  CHAT_MODELS: [
    "xai/grok-4-fast",
    "xai/grok-4-fast-reasoning",
    "anthropic/claude-haiku-4-5",
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash",
    "deepseek/deepseek-reasoner",
    "deepseek/deepseek-chat",
  ],

  IMAGE_MODELS: [
    "fal-ai/flux-2",
    "fal-ai/flux-2-pro",
    "fal-ai/nano-banana",
    "fal-ai/nano-banana-pro",
    "fal-ai/stable-diffusion-v35-large",
  ],

  DEFAULT_CHAT_MODEL: "xai/grok-4-fast",
  DEFAULT_IMAGE_MODEL: "fal-ai/flux-2",

  BASE_HEADERS: {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "origin": "https://typli.ai",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  }
};

// --- [第二部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    request.ctx = { apiKey };

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCorsPreflight();
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);

    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 逻辑] ---
async function handleApi(request) {
  if (!verifyAuth(request)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  switch (url.pathname) {
    case '/v1/models':
      return handleModelsRequest();
    case '/v1/chat/completions':
    case '/v1/images/generations':
      return handleChatCompletions(request, requestId);
    default:
      return createErrorResponse('Not Found', 404, 'not_found');
  }
}

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true;
  return auth === `Bearer ${key}`;
}

function handleModelsRequest() {
  const allModels = [...CONFIG.CHAT_MODELS, ...CONFIG.IMAGE_MODELS];
  const modelsData = {
    object: 'list',
    data: allModels.map(id => ({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'typli-2api' })),
  };
  return new Response(JSON.stringify(modelsData), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

// 🔥 核心：聊天/图片生成处理
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const model = body.model || CONFIG.DEFAULT_CHAT_MODEL;
    const isImageModel = CONFIG.IMAGE_MODELS.includes(model);

    let prompt = body.prompt;
    if (!prompt) {
      const lastUserMessage = body.messages?.filter(m => m.role === 'user').pop();
      prompt = lastUserMessage?.content;
    }
    if (!prompt) return createErrorResponse("无法找到有效的 prompt。", 400, 'invalid_request');

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        // 🔥 关键步骤 1: 先获取 CSRF 会话（必须在生成 sessionId 之前）
        const typliSession = await getTypliCsrfToken();
        if (!typliSession) {
          throw new Error('无法建立 Typli 会话 (CSRF)');
        }

        if (isImageModel) {
          // --- 图片生成逻辑 ---
          const payload = { prompt, model };
          const headers = {
            ...CONFIG.BASE_HEADERS,
            "referer": CONFIG.REFERER_IMAGE_URL,
            "Cookie": typliSession.cookies
          };
          if (typliSession.csrfToken) {
            headers["X-CSRF-Token"] = typliSession.csrfToken;
            headers["X-XSRF-TOKEN"] = typliSession.csrfToken;
          }

          const response = await fetch(CONFIG.UPSTREAM_IMAGE_URL, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`上游图片服务错误 (${response.status}): ${errText}`);
          }

          const result = await response.json();
          if (result.error || !result.url) {
            throw new Error(`图片生成失败: ${result.error || '未返回URL'}`);
          }

          const markdownContent = `![${prompt}](${result.url})`;
          const contentChunk = createChatCompletionChunk(requestId, model, markdownContent);
          await writer.write(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));

        } else {
          // --- 聊天逻辑 ---
          // 🔥 关键步骤 2: CSRF 获取后，再生成 sessionId
          const sessionId = generateRandomId(16);

          const typliMessages = (body.messages || []).map(msg => ({
            parts: [{ type: "text", text: msg.content }],
            id: generateRandomId(16),
            role: msg.role
          }));

          const payload = {
            slug: "free-no-sign-up-chatgpt",
            modelId: model,
            id: sessionId,
            messages: typliMessages,
            trigger: "submit-message"
          };

          const headers = {
            ...CONFIG.BASE_HEADERS,
            "referer": CONFIG.REFERER_CHAT_URL,
            "Cookie": typliSession.cookies
          };
          if (typliSession.csrfToken) {
            headers["X-CSRF-Token"] = typliSession.csrfToken;
            headers["X-XSRF-TOKEN"] = typliSession.csrfToken;
          }

          console.log('📤 Sending chat request:', {
            sessionId,
            cookieLength: typliSession.cookies?.length || 0,
            hasCsrf: !!typliSession.csrfToken
          });

          const response = await fetch(CONFIG.UPSTREAM_CHAT_URL, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`上游聊天服务错误 (${response.status}): ${errText}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const data = JSON.parse(dataStr);

                // 🔥 双格式解析：优先读取 text-delta，其次读取 reasoning-delta
                let deltaText = null;

                // 格式 1: 标准 text-delta (旧版)
                if (data.type === 'text-delta' && data.delta) {
                  deltaText = data.delta;
                }
                // 格式 2: text 字段 (某些版本)
                else if (data.type === 'text-delta' && data.text) {
                  deltaText = data.text;
                }
                // 格式 3: reasoning-delta (推理模型，只取推理内容作为输出)
                else if (data.type === 'reasoning-delta' && data.delta) {
                  // 推理内容通常不是最终输出，但某些客户端需要
                  // 这里可以选择跳过，或者作为 reasoning 字段输出
                  console.log('🧠 Reasoning delta (skipped):', data.delta?.substring(0, 50));
                  // deltaText = data.delta; // 如果需要推理内容，取消注释
                }

                if (deltaText) {
                  const chunk = createChatCompletionChunk(requestId, model, deltaText);
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch (e) {
                // 忽略解析错误，继续处理
              }
            }
          }
        }

        // 发送结束信号
        const endChunk = createChatCompletionChunk(requestId, model, null, "stop");
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        const errorContent = `\n\n[服务代理错误: ${e.message}]`;
        const errorChunk = createChatCompletionChunk(requestId, model, errorContent, "stop");
        await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- [第四部分: 辅助函数] ---

function generateRandomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

// 🔥 获取 CSRF Token 和 Cookies
async function getTypliCsrfToken() {
  try {
    const initResponse = await fetch(CONFIG.REFERER_CHAT_URL, {
      method: 'GET',
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'user-agent': CONFIG.BASE_HEADERS['user-agent'],
        'sec-ch-ua': CONFIG.BASE_HEADERS['sec-ch-ua'],
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1',
      },
      redirect: 'follow'
    });

    if (!initResponse.ok) {
      console.warn('获取 Typli 页面失败:', initResponse.status);
      return null;
    }

    const setCookieHeaders = initResponse.headers.getAll('Set-Cookie');
    let cookieString = '';
    let csrfToken = null;

    for (const header of setCookieHeaders) {
      const cookiePart = header.split(';')[0];
      cookieString += cookiePart + '; ';

      const match = header.match(/(__Host-csrf|csrf|XSRF-TOKEN)=([^;]+)/i);
      if (match) {
        csrfToken = match[2];
      }
    }

    if (!csrfToken) {
      const html = await initResponse.text();
      const htmlMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/i) ||
                        html.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i) ||
                        html.match(/csrf-token["']?\s*[:=]\s*["']([^"']+)["']/i);
      if (htmlMatch) csrfToken = htmlMatch[1];
    }

    if (!cookieString && !csrfToken) return null;

    console.log('🔑 CSRF Session:', {
      cookieLength: cookieString.length,
      hasCsrf: !!csrfToken
    });

    return { cookies: cookieString.trim(), csrfToken };

  } catch (e) {
    console.error('CSRF 获取失败:', e.message);
    return null;
  }
}

function createChatCompletionChunk(id, model, content, finishReason = null) {
  const chunk = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  };
  if (content) chunk.choices[0].delta.content = content;
  return chunk;
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code } }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第五部分: WebUI] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --success: #66BB6A; --error: #CF6679; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 10px; border-radius: 4px; cursor: pointer; }
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; }
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      .tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 15px; }
      .tab-button { padding: 10px 15px; cursor: pointer; background: none; border: none; color: #888; font-weight: 600; border-bottom: 2px solid transparent; }
      .tab-button.active { color: var(--primary); border-bottom-color: var(--primary); }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; word-wrap: break-word; }
      .msg.user { align-self: flex-end; background: #333; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; }
      .msg.error { color: var(--error); border-color: var(--error); }
      .log-panel { height: 150px; background: #111; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #aaa; overflow-y: auto; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>🚀 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888;">v${CONFIG.PROJECT_VERSION}</span></h2>
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>
        <div class="box">
            <span class="label">API 入口</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>
        <div class="box">
            <div class="tabs">
                <button class="tab-button active" onclick="openTab('chat-tab')">💬 聊天</button>
                <button class="tab-button" onclick="openTab('image-tab')">🎨 文生图</button>
            </div>
            <div id="chat-tab" class="tab-content active">
                <select id="chat-model">${CONFIG.CHAT_MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
                <textarea id="chat-prompt" rows="5">你好，请介绍一下你自己。</textarea>
                <button id="btn-chat" onclick="sendChatRequest()">🚀 发送</button>
            </div>
            <div id="image-tab" class="tab-content">
                <select id="image-model">${CONFIG.IMAGE_MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
                <textarea id="image-prompt" rows="5"></textarea>
                <button id="btn-image" onclick="sendImageRequest()">🎨 生成</button>
            </div>
        </div>
    </div>
    <main class="main">
        <div class="chat-window" id="output-window">
            <div id="initial-message" style="color:#666; text-align:center; margin-top:100px;">
                <h3>Typli 代理服务就绪</h3>
                <p>CSRF 已修复，双格式解析已启用。</p>
            </div>
        </div>
        <div class="log-panel" id="logs"><div>[System] 初始化完成</div></div>
    </main>
    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        function openTab(t) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-button').forEach(el => el.classList.remove('active'));
            document.getElementById(t).classList.add('active');
            event.target.classList.add('active');
        }
        function copy(t) { navigator.clipboard.writeText(t); }
        function log(m) { const d = document.getElementById('logs'); d.innerHTML += '<div>[' + new Date().toLocaleTimeString() + '] ' + m + '</div>'; d.scrollTop = d.scrollHeight; }
        function appendMsg(role, text) {
            const d = document.createElement('div'); d.className = 'msg ' + role; d.innerText = text;
            document.getElementById('output-window').appendChild(d); d.scrollIntoView();
            return d;
        }
        async function sendRequest(payload, prompt) {
            const init = document.getElementById('initial-message'); if (init) init.style.display = 'none';
            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '▋');
            log('请求: ' + prompt.substring(0, 30));
            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let full = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value);
                    for (const line of chunk.split('\\n')) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;
                            try {
                                const data = JSON.parse(dataStr);
                                const content = data.choices[0]?.delta?.content || '';
                                full += content;
                                aiMsg.innerText = full + '▋';
                            } catch (e) {}
                        }
                    }
                }
                aiMsg.innerText = full;
                log('完成');
            } catch (e) {
                aiMsg.classList.add('error');
                aiMsg.innerText += '\\n[错误: ' + e.message + ']';
                log('错误: ' + e.message);
            }
        }
        function sendChatRequest() {
            const p = document.getElementById('chat-prompt').value.trim();
            if (!p) return;
            sendRequest({ model: document.getElementById('chat-model').value, messages: [{ role: 'user', content: p }], stream: true }, p);
        }
        function sendImageRequest() {
            const p = document.getElementById('image-prompt').value.trim();
            if (!p) return;
            sendRequest({ model: document.getElementById('image-model').value, messages: [{ role: 'user', content: p }], stream: true }, p);
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
