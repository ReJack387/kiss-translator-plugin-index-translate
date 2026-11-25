#!/usr/bin/env node
// 直接调用 Bilibili Index-Translate 公开接口，用来确认网络、模型和提示词是否可用。
// 不经过简约翻译宿主，也不依赖本插件的脚本运行时。
//
// 用法：
//   node tools/probe.mjs "技术赋能创作，让交流跨越语言的界限。" -t en
//   node tools/probe.mjs "Hello, world!" -t zh -m Index-Translate-9B
//   node tools/probe.mjs "今天天气真好。" -t ja --stream
//   node tools/probe.mjs --image screenshot.png -t zh
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const DEFAULT_BASE = "https://index-translate.bilibili.com/v1";
const DEFAULT_MODEL = "Index-Translate-35B-A3B";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

function parseArgs(argv) {
  const options = {
    text: "",
    target: "zh",
    source: "auto",
    model: DEFAULT_MODEL,
    base: DEFAULT_BASE,
    maxTokens: 4096,
    stream: false,
    image: "",
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      return value;
    };
    if (arg === "-t" || arg === "--target") options.target = next();
    else if (arg === "-s" || arg === "--source") options.source = next();
    else if (arg === "-m" || arg === "--model") options.model = next();
    else if (arg === "--base") options.base = next();
    else if (arg === "--max-tokens") options.maxTokens = Number(next());
    else if (arg === "--image" || arg === "--img") options.image = next();
    else if (arg === "--stream") options.stream = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`未知参数：${arg}`);
    else positional.push(arg);
  }
  options.text = positional.join(" ").trim();
  return options;
}

function buildPrompt(text, target, source, image = false) {
  const head =
    source && source !== "auto"
      ? `请将以下 ${source} 原文翻译为 ${target}`
      : `请将以下文本翻译为 ${target}`;
  const imageHead = `请将图片中的文本翻译为 ${target}`;
  const body = text ? `\n\n${text}` : "";
  return `${image ? imageHead : head}，直接输出翻译结果，不要进行任何解释。${body}`;
}

async function imageToDataUrl(path) {
  const bytes = await readFile(path);
  const mime = MIME[extname(path).toLowerCase()] || "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function stripThink(text) {
  const value = String(text ?? "");
  const close = value.lastIndexOf("</think>");
  return (close === -1 ? value : value.slice(close + 8)).trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node tools/probe.mjs <文本> [-t 目标语言] [-s 源语言] [-m 模型] [--image 图片] [--stream]");
    return;
  }
  if (!options.text && !options.image) {
    throw new Error("请提供待翻译文本，或用 --image 指定图片");
  }

  const content = options.image
    ? [
        {
          type: "text",
          text: buildPrompt(options.text, options.target, options.source, true),
        },
        { type: "image_url", image_url: { url: await imageToDataUrl(options.image) } },
      ]
    : buildPrompt(options.text, options.target, options.source);

  const url = `${options.base.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Index-Translate-Client/1.0",
    },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: options.maxTokens,
      stream: options.stream,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}\n${body.slice(0, 800)}`);
  }

  if (!options.stream) {
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    console.log(stripThink(text));
    return;
  }

  if (!response.body) throw new Error("响应没有可读的流");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        process.stdout.write("\n");
        return;
      }
      try {
        const event = JSON.parse(payload);
        const delta = event?.choices?.[0]?.delta?.content;
        if (delta) process.stdout.write(delta);
      } catch {
        // 心跳或非 JSON 行，忽略。
      }
    }
  }
  process.stdout.write("\n");
}

main().catch((error) => {
  console.error(`调用失败：${error.message}`);
  process.exitCode = 1;
});
