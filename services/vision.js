// Bilibili Index-Translate —— 图片文字识别适配层（KISS Translator 插件 API 1）
//
// 复用与文本服务相同的公开端点，图片以 OpenAI 多模态 image_url（base64 data URL）上传。
// 参考：https://github.com/bilibili/Index-Translate/blob/main/inference/llm/call_api.py
//
// 本能力只返回识别结果（coordinates: false），不伪造文字坐标；
// 需要「图片翻译」时请让文本服务翻译识别出的原文。

var DEFAULT_MAX_TOKENS = 4096;
var MIN_MAX_TOKENS = 256;
var MAX_MAX_TOKENS = 16384;
var THINK_CLOSE = "</think>";

function resolveMaxTokens(config) {
  var raw = config ? config.maxTokens : undefined;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_TOKENS;
  var value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)));
}

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

function responseToText(result) {
  if (!result) return "";
  if (typeof result.text === "string") return result.text;
  return contentToText(result.content);
}

function stripThinkBlocks(text) {
  var value = String(text == null ? "" : text);
  var close = value.lastIndexOf(THINK_CLOSE);
  if (close !== -1) value = value.slice(close + THINK_CLOSE.length);
  return value.replace(/^\s*<think>/, "").trim();
}

function withHint(error) {
  var message = error && error.message ? error.message : String(error);
  var code = error && error.code ? error.code : "UPSTREAM_ERROR";
  if (code === "HTTP_ERROR") {
    message += "（若为 403/412：请在「基本设置 → 禁用Origin名单」加入 https://index-translate.bilibili.com，或改用 tools/bridge.mjs 本地桥接）";
  }
  return Object.assign(new Error(message), { code: code });
}

exports.parseImage = async function (input, config, ctx) {
  if (!config || !config.baseUrl) {
    throw new Error("请在服务配置中填写 API 基础地址，例如 https://index-translate.bilibili.com/v1");
  }
  if (!config.model) {
    throw new Error("请选择视觉模型，例如 Index-Translate-35B-A3B");
  }
  if (!input || !input.image) {
    throw new Error("缺少待识别的图片");
  }

  // 任务资产由宿主提供，脚本只能通过 ctx.assets.read 读取本次字节。
  var bytes = await ctx.assets.read(input.image);
  var messages = await ctx.helpers.openai.chatCompletions.prepareMessages(
    ctx.helpers.textTasks.buildMessages("parseImage", input),
    async function () {
      return bytes;
    },
  );

  var request = ctx.helpers.openai.chatCompletions.buildRequest({
    baseUrl: config.baseUrl,
    model: config.model,
    messages: messages,
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
  var text = stripThinkBlocks(responseToText(result));
  if (!text) {
    throw Object.assign(new Error("上游返回了空识别结果，请确认图片包含可读文字"), {
      code: "EMPTY_RESPONSE",
    });
  }

  return ctx.helpers.textTasks.parseResult("parseImage", text, input);
};
