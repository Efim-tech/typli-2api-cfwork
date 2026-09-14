/**
 * =================================================================================
 * 项目: typli-2api (Cloudflare Worker 单文件版)
 * 版本: 2.2.0 (代号: Chimera Vision - TrueStream Adapter)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-09
 *
 * [核心特性]
 * 1. [无限续杯] 每次请求自动生成全新 Session ID，绕过 1000 词额度限制。
 * 2. [多模态支持] 同时支持 Grok-4 聊天模型与多种文生图模型。
 * 3. [协议转换] 将 Typli 的自定义 SSE 格式与图片生成接口完美转换为 OpenAI 兼容格式。
 * 4. [开发者驾驶舱] 内置全功能中文调试界面，支持聊天与文生图的实时测试与日志监控。
 * 5. [通用流式适配] 所有响应均以流式（SSE）格式返回，完美兼容各类聊天客户端。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "typli-2api",
  PROJECT_VERSION: "2.2.0",

  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1",

  // 上游服务配置
  UPSTREAM_CHAT_URL: "https://typli.ai/api/generators/chat",
  UPSTREAM_IMAGE_URL: "https://typli.ai/api/generators/images",
  ORIGIN_URL: "https://typli.ai",
  REFERER_CHAT_URL: "https://typli.ai/free-no-sign-up-chatgpt",
  REFERER_IMAGE_URL: "https://typli.ai/ai-image-generator",

  // 聊天模型列表 (来源于抓包与JS分析)
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
    "grok-4",      // 别名
    "gpt-4o",      // 兼容性别名
    "gpt-3.5-turbo" // 兼容性别名
  ],

  // 绘图模型列表 (来源于 JS Chunk 519972)
  IMAGE_MODELS: [
    "fal-ai/flux-2",
    "fal-ai/flux-2-pro",
    "fal-ai/flux-2-lora-gallery/realism",
    "fal-ai/nano-banana",
    "fal-ai/nano-banana-pro",
    "fal-ai/stable-diffusion-v35-large",
    "fal-ai/recraft/v3/text-to-image",
    "imagineart/imagineart-1.5-preview/text-to-image",
    "fal-ai/bytedance/seedream/v4.5/text-to-image"
  ],

  DEFAULT_CHAT_MODEL: "xai/grok-4-fast",
  DEFAULT_IMAGE_MODEL: "fal-ai/flux-2",

  // 伪装指纹 (严格复刻 Chrome 142)
  BASE_HEADERS: {
    "authority": "typli.ai",
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

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    request.ctx = { apiKey }; // 注入上下文

    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 路由分发
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);

    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request) {
  if (!verifyAuth(request)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  switch (url.pathname) {
    case '/v1/models':
      return handleModelsRequest();
    case '/v1/chat/completions':
      return handleChatCompletions(request, requestId);
    case '/v1/images/generations':
      // 为了最大兼容性，让 /v1/images/generations 也走聊天接口的逻辑
      return handleChatCompletions(request, requestId);
    default:
      return createErrorResponse('Not Found', 404, 'not_found');
  }
}

// 鉴权逻辑
function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true; // 默认密钥 "1" 允许所有请求
  return auth === `Bearer ${key}`;
}

// 模型列表接口
function handleModelsRequest() {
  const allModels = [...CONFIG.CHAT_MODELS, ...CONFIG.IMAGE_MODELS];
  const modelsData = {
    object: 'list',
    data: allModels.map(id => ({
      id: id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'typli-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// 统一聊天/图片生成接口 (智能路由 + 统一流式输出)
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const model = body.model || CONFIG.DEFAULT_CHAT_MODEL;

    // 检查是否为图片模型
    const isImageModel = CONFIG.IMAGE_MODELS.includes(model);

    // 提取 prompt
    // 对于 /v1/images/generations, prompt 在 body.prompt
    // 对于 /v1/chat/completions, prompt 在最后一个用户消息中
    let prompt = body.prompt;
    if (!prompt) {
      const lastUserMessage = body.messages?.filter(m => m.role === 'user').pop();
      prompt = lastUserMessage?.content;
    }

    if (!prompt) {
      return createErrorResponse("无法找到有效的 prompt。", 400, 'invalid_request');
    }

    // 启动流式响应
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        if (isImageModel) {
          // --- 图片模型逻辑：获取URL并作为单个流式块发送 ---
          const payload = { prompt, model };
          const headers = { ...CONFIG.BASE_HEADERS, "referer": CONFIG.REFERER_IMAGE_URL };
          const response = await fetch(CONFIG.UPSTREAM_IMAGE_URL, {
            method: "POST",
            headers: headers,
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

          const imageUrl = result.url;
          const markdownContent = `![${prompt}](${imageUrl})`;

          // 发送包含完整内容的单个数据块
          const contentChunk = createChatCompletionChunk(requestId, model, markdownContent);
          await writer.write(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));

        } else {
          // --- 聊天模型逻辑：代理上游流式响应 (С ИСПРАВЛЕНИЕМ CSRF) ---

          // 🔥 ШАГ 1: Получаем CSRF-токен и cookies с главной страницы
          const typliSession = await getTypliCsrfToken();

          if (!typliSession) {
            throw new Error('Не удалось установить сессию с Typli.ai (CSRF)');
          }

          console.log('🔑 CSRF session obtained:', {
            hasCookies: !!typliSession.cookies,
            cookiesLength: typliSession.cookies?.length || 0,
            hasCsrfToken: !!typliSession.csrfToken,
            csrfToken: typliSession.csrfToken
          });

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

          // 🔥 ШАГ 2: Формируем заголовки с полученными cookies
          const headers = {
            ...CONFIG.BASE_HEADERS,
            "referer": CONFIG.REFERER_CHAT_URL,
            // Добавляем cookies, которые получили ранее
            "Cookie": typliSession.cookies
          };

          // 🔥 ШАГ 3: Если нашли CSRF-токен, добавляем его в заголовки
          if (typliSession.csrfToken) {
            headers["X-CSRF-Token"] = typliSession.csrfToken;
            headers["X-XSRF-TOKEN"] = typliSession.csrfToken;
          }

          console.log('📤 Sending chat request with headers:', {
            referer: headers.referer,
            cookieLength: headers.Cookie?.length || 0,
            hasCsrf: !!headers['X-CSRF-Token']
          });

          const response = await fetch(CONFIG.UPSTREAM_CHAT_URL, {
            method: "POST",
            headers: headers,
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
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim();
                if (dataStr === '[DONE]') continue;

                try {
                  const data = JSON.parse(dataStr);
                  if (data.type === 'text-delta' && data.delta) {
                    const chunk = createChatCompletionChunk(requestId, model, data.delta);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                } catch (e) { /* 忽略解析错误 */ }
              }
            }
          }
        }

        // 统一发送结束块和 [DONE] 标志
        const endChunk = createChatCompletionChunk(requestId, model, null, "stop");
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        // 在流中报告错误
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
    // 对于请求体解析等早期错误，返回非流式错误
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

// 🔥 НОВАЯ ФУНКЦИЯ: Получение CSRF-токена и cookies от Typli.ai
async function getTypliCsrfToken() {
  try {
    // 1. Делаем GET-запрос на страницу чата, чтобы получить cookies
    const initResponse = await fetch(CONFIG.REFERER_CHAT_URL, {
      method: 'GET',
      headers: {
        ...CONFIG.BASE_HEADERS,
        // Убираем content-type для GET-запроса, он не нужен
        'content-type': undefined,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1',
      },
      redirect: 'follow'
    });

    if (!initResponse.ok) {
      console.warn('Не удалось загрузить страницу Typli для получения CSRF:', initResponse.status);
      return null;
    }

    // 2. Извлекаем cookies из заголовков ответа
    const setCookieHeaders = initResponse.headers.getAll('Set-Cookie');
    let cookieString = '';
    let csrfToken = null;

    for (const header of setCookieHeaders) {
      // Собираем все cookies в одну строку
      const cookiePart = header.split(';')[0];
      cookieString += cookiePart + '; ';

      // Ищем CSRF токен в cookie (обычно называется __Host-csrf, csrf, или XSRF-TOKEN)
      const match = header.match(/(__Host-csrf|csrf|XSRF-TOKEN)=([^;]+)/i);
      if (match) {
        csrfToken = match[2];
        console.log('🔑 Найден CSRF токен в cookie:', csrfToken);
      }
    }

    // 3. Если CSRF токена нет в cookies, пробуем найти его в HTML
    if (!csrfToken) {
      const html = await initResponse.text();
      // Ищем CSRF токен в HTML (паттерны могут быть разными)
      const htmlMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/i) ||
                        html.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i) ||
                        html.match(/csrf-token["']?\s*[:=]\s*["']([^"']+)["']/i);
      if (htmlMatch) {
        csrfToken = htmlMatch[1];
        console.log('🔑 Найден CSRF токен в HTML:', csrfToken);
      }
    }

    if (!cookieString && !csrfToken) {
      console.warn('Не удалось получить ни cookies, ни CSRF токен');
      return null;
    }

    // Возвращаем и cookies, и токен
    return {
      cookies: cookieString.trim(),
      csrfToken: csrfToken
    };

  } catch (e) {
    console.error('Ошибка при получении CSRF токена:', e.message);
    return null;
  }
}

function createChatCompletionChunk(id, model, content, finishReason = null) {
  const chunk = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: finishReason
    }]
  };
  if (content) {
    chunk.choices[0].delta.content = content;
  }
  return chunk;
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
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

// --- [第五部分: 开发者驾驶舱 UI (WebUI)] ---
// (Web UI 代码未作任何修改，保持原样)
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
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; --success: #66BB6A; --error: #CF6679; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 10px; border-radius: 4px; cursor: pointer; transition: background 0.2s; }
      .code-block:hover { background: #000; }
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; font-family: inherit; }
      input:focus, textarea:focus { border-color: var(--primary); outline: none; }
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; transition: opacity 0.2s; }
      button:hover { opacity: 0.9; }
      button:disabled { background: #555; cursor: not-allowed; }
      .tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 15px; }
      .tab-button { padding: 10px 15px; cursor: pointer; background: none; border: none; color: #888; font-weight: 600; border-bottom: 2px solid transparent; }
      .tab-button.active { color: var(--primary); border-bottom-color: var(--primary); }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; word-wrap: break-word; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; border-bottom-right-radius: 2px; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; border-bottom-left-radius: 2px; }
      .msg.error { color: var(--error); border-color: var(--error); }
      .image-container { text-align: center; margin-top: 20px; }
      .image-container img { max-width: 100%; max-height: 70vh; border-radius: 8px; border: 1px solid var(--border); }
      .log-panel { height: 150px; background: #111; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #aaa; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; }
      .log-time { color: #666; margin-right: 5px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="header" style="margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px;">
            <h2 style="margin:0; display:flex; align-items:center; gap:10px;">
                🚀 ${CONFIG.PROJECT_NAME}
                <span style="font-size:12px;color:#888; font-weight:normal; margin-top:4px;">v${CONFIG.PROJECT_VERSION}</span>
            </h2>
        </div>
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>
        <div class="box">
            <span class="label">统一 API 入口 (聊天/文生图)</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>
        <div class="box">
            <div class="tabs">
                <button class="tab-button active" onclick="openTab('chat-tab')">💬 聊天</button>
                <button class="tab-button" onclick="openTab('image-tab')">🎨 文生图</button>
            </div>
            <div id="chat-tab" class="tab-content active">
                <span class="label">聊天模型</span>
                <select id="chat-model">
                    ${CONFIG.CHAT_MODELS.map(m => `<option value="${m}" ${m === CONFIG.DEFAULT_CHAT_MODEL ? 'selected' : ''}>${m}</option>`).join('')}
                </select>
                <span class="label">提示词 (Prompt)</span>
                <textarea id="chat-prompt" rows="5" placeholder="输入你的问题...">你好，请介绍一下你自己。</textarea>
                <button id="btn-chat" onclick="sendChatRequest()">🚀 发送聊天请求</button>
            </div>
            <div id="image-tab" class="tab-content">
                <span class="label">绘图模型</span>
                <select id="image-model">
                    ${CONFIG.IMAGE_MODELS.map(m => `<option value="${m}" ${m === CONFIG.DEFAULT_IMAGE_MODEL ? 'selected' : ''}>${m}</option>`).join('')}
                </select>
                <span class="label">提示词 (Prompt)</span>
                <textarea id="image-prompt" rows="5" placeholder="描述你想要生成的图片..."></textarea>
                <button id="btn-image" onclick="sendImageRequest()">🎨 生成图片</button>
            </div>
        </div>
    </div>
    <main class="main">
        <div class="chat-window" id="output-window">
            <div id="initial-message" style="color:#666; text-align:center; margin-top:100px;">
                <div style="font-size:40px; margin-bottom:20px;">🤖</div>
                <h3>Typli 代理服务就绪</h3>
                <p>每次请求自动生成新身份，绕过 1000 词限制。<br>体验极速 Grok-4 推理与文生图能力。</p>
            </div>
        </div>
        <div class="log-panel" id="logs">
            <div class="log-entry"><span class="log-time">[System]</span> 驾驶舱初始化完成。</div>
        </div>
    </main>
    <script>
        const API_KEY = "${apiKey}";
        const CHAT_ENDPOINT = "${origin}/v1/chat/completions";
        // Web UI 的图片请求也统一走 CHAT_ENDPOINT
        const IMAGE_ENDPOINT = "${origin}/v1/chat/completions"; 

        function openTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
            document.getElementById(tabName).classList.add('active');
            event.currentTarget.classList.add('active');
        }

        function copy(text) {
            navigator.clipboard.writeText(text);
            log('System', '已复制到剪贴板');
        }

        function log(type, msg) {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> <span style="color:var(--primary)">[\${type}]</span> \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function clearOutput() {
            const initialMsg = document.getElementById('initial-message');
            if (initialMsg) initialMsg.style.display = 'none';
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            document.getElementById('output-window').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }
        
        function renderContent(element, text) {
            // 简单的 Markdown 图片渲染
            const markdownImageRegex = /!\\\[(.*?)\\]\\((.*?)\\)/g;
            let lastIndex = 0;
            let htmlContent = '';

            text.replace(markdownImageRegex, (match, alt, src, offset) => {
                htmlContent += text.substring(lastIndex, offset); // 添加图片前的文本
                htmlContent += \`<div class="image-container"><img src="\${src}" alt="\${alt}" style="max-width:100%; border-radius: 8px;" /></div>\`;
                lastIndex = offset + match.length;
                return match;
            });
            htmlContent += text.substring(lastIndex); // 添加最后一张图片后的文本

            if (lastIndex > 0) { // 如果有图片
                element.innerHTML = htmlContent;
            } else {
                element.innerText = text;
            }
        }

        async function handleStreamRequest(endpoint, payload, userPrompt) {
            clearOutput();
            appendMsg('user', userPrompt);
            const aiMsg = appendMsg('ai', '▋');
            log('Request', \`发送请求: \${userPrompt.substring(0, 30)}...\`);

            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullText = "";
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;
                            try {
                                const data = JSON.parse(dataStr);
                                const content = data.choices[0]?.delta?.content || "";
                                fullText += content;
                                renderContent(aiMsg, fullText + "▋");
                                aiMsg.scrollIntoView({ behavior: "smooth", block: "end" });
                            } catch (e) {}
                        }
                    }
                }
                renderContent(aiMsg, fullText);
                log('Response', '响应接收完成');

            } catch (e) {
                aiMsg.classList.add('error');
                aiMsg.innerText += \`\n[错误: \${e.message}]\`;
                log('Error', e.message);
            }
        }

        async function sendChatRequest() {
            const prompt = document.getElementById('chat-prompt').value.trim();
            if (!prompt) return;
            const btn = document.getElementById('btn-chat');
            btn.disabled = true;
            
            const payload = {
                model: document.getElementById('chat-model').value,
                messages: [{ role: 'user', content: prompt }],
                stream: true
            };
            
            await handleStreamRequest(CHAT_ENDPOINT, payload, prompt);
            btn.disabled = false;
        }

        async function sendImageRequest() {
            const prompt = document.getElementById('image-prompt').value.trim();
            if (!prompt) return;
            const btn = document.getElementById('btn-image');
            btn.disabled = true;

            const payload = {
                model: document.getElementById('image-model').value,
                messages: [{ role: 'user', content: prompt }], // 统一使用 messages 格式
                stream: true
            };

            await handleStreamRequest(IMAGE_ENDPOINT, payload, prompt);
            btn.disabled = false;
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
