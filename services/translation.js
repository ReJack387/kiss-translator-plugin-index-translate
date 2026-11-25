// Bilibili Index-Translate —— 文本翻译适配层（KISS Translator 插件 API 1）
//
// 上游协议：OpenAI Chat Completions 兼容
//   POST {baseUrl}/chat/completions
//   参考：https://github.com/bilibili/Index-Translate/blob/main/inference/llm/call_api.py
//   公开免费接口 https://index-translate.bilibili.com/v1 不需要鉴权。
//
// 三个关键点（缺一不可）：
//   1. chat_template_kwargs.enable_thinking = false：该模型被训练为直接输出译文，
//      开启思考时推理文本可能取代译文出现在 content 里。
//   2. temperature = 0：翻译任务使用贪心解码，避免改写与漏译。
//   3. 只声明 complete 输出：公共接口的 SSE 行为不受保证，宿主聚合/断句也只接受完整结果。
//
// 宿主负责：模型/语言/术语/上下文的展开、聚合调度、按 ID 对齐与校验。
// 本文件只负责：构造请求、清理模型输出、把文本交回宿主解析。

var DEFAULT_MAX_TOKENS = 4096;
var MIN_MAX_TOKENS = 256;
var MAX_MAX_TOKENS = 16384;

// 实例配置里的 maxTokens 可能缺失、被清空或越界，这里统一收敛到安全范围。
function resolveMaxTokens(config) {
  var raw = config ? config.maxTokens : undefined;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_TOKENS;
  var value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)));
}

// 兼容个别实现把 content 拆成 parts 数组的情况。
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  var parts = [];
  for (var i = 0; i < content.length; i++) {
    var part = content[i];
    if (part && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

// /chat/completions 的 content 是惰性输出；把它交给下一步清洗。
function responseToText(result) {
  if (!result) return "";
  if (typeof result.text === "string") return result.text;
  return contentToText(result.content);
}

// 去掉 <think>...</think>。正常关闭思考时不应出现，这里只做兜底。
// 与 call_api.py::strip_think 一致：保留最后一个 </think> 之后的内容。
function stripThinkBlocks(text) {
  var value = String(text == null ? "" : text);
  var close = value.lastIndexOf("</think>");
  if (close !== -1) value = value.slice(close + "</think>".length);
  return value.replace(/^\s*<think>/, "").trim();
}

// 聚合协议要求原始 JSON，但模型偶尔仍会套一层 Markdown 代码块。
// 仅在整段确实被围栏包裹时剥离，避免破坏单条纯文本译文。
function stripJsonFence(text) {
  var match = /^\s*```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text);
  return match ? match[1].trim() : text;
}

function cleanOutput(text, protocol) {
  var value = stripThinkBlocks(text);
  if (protocol === "json") value = stripJsonFence(value);
  return value;
}

// 上游 403/412 通常来自浏览器 Origin 校验或公共接口限流，错误里给出可执行的提示。
function withHint(error) {
  var message = error && error.message ? error.message : String(error);
  var code = error && error.code ? error.code : "UPSTREAM_ERROR";
  if (code === "HTTP_ERROR") {
    message += "（若为 403/412：请在「基本设置 → 禁用Origin名单」加入 https://index-translate.bilibili.com，或改用 tools/bridge.mjs 本地桥接）";
  }
  return Object.assign(new Error(message), { code: code });
}

exports.translate = async function (input, config, ctx) {
  if (!config || !config.baseUrl) {
    throw new Error("请在服务配置中填写 API 基础地址，例如 https://index-translate.bilibili.com/v1");
  }
  if (!config.model) {
    throw new Error("请选择模型，例如 Index-Translate-35B-A3B");
  }

  var request = ctx.helpers.openai.chatCompletions.buildRequest({
    baseUrl: config.baseUrl,
    model: config.model,
    messages: ctx.helpers.translation.buildMessages(input),
    temperature: 0,
    max_tokens: resolveMaxTokens(config),
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  });

  var response;
  try {
    response = await ctx.http.request(request);
  } catch (error) {
    throw withHint(error);
  }

  var result = ctx.helpers.openai.chatCompletions.parseResponse(response);
  var text = cleanOutput(responseToText(result), input && input.outputProtocol);
  if (!text) {
    throw Object.assign(new Error("上游返回了空译文，请稍后重试或更换模型"), {
      code: "EMPTY_RESPONSE",
    });
  }

  // parseResult 会按输入 ID 重排、拒绝缺项/重复/空白译文；不要自行按顺序配对。
  return ctx.helpers.translation.parseResult(text, input);
};
