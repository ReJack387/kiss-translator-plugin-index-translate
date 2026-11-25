#!/usr/bin/env node
// 可选联调：用真实宿主 SDK 执行本插件的 handler（会访问公网接口，不在 npm test 里）。
//
// 准备步骤：
//   1. git clone --depth 1 -b dev https://github.com/fishjar/kiss-translator.git host
//   2. npm i --no-save esbuild fflate @streamparser/json
//   3. cat > host-entry.mjs <<'EOF'
//      export { providerHelpers } from "./host/src/providers/sdk/index.js";
//      export { createTranslationHelpers } from "./host/src/providers/sdk/translation.js";
//      export { readProviderPackage } from "./host/src/providers/package.js";
//      EOF
//   4. npx esbuild host-entry.mjs --bundle --platform=node --format=esm --outfile=host-sdk.mjs
//   5. KISS_HOST_SDK=./host-sdk.mjs node tools/sdk-check.mjs
//
// host-sdk.mjs 只是把宿主的 ESM 源码打包成 Node 可加载的模块；不修改宿主代码。
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const { translate } = require(join(ROOT, "services/translation.js"));
const { parseImage } = require(join(ROOT, "services/vision.js"));

const sdkPath = process.env.KISS_HOST_SDK;
if (!sdkPath) {
  console.error("请先设置 KISS_HOST_SDK 指向打包后的宿主 SDK，例如：\n  KISS_HOST_SDK=./host-sdk.mjs node tools/sdk-check.mjs");
  process.exit(2);
}
const sdk = await import(pathToFileURL(isAbsolute(sdkPath) ? sdkPath : resolve(process.cwd(), sdkPath)).href);
for (const name of ["providerHelpers", "createTranslationHelpers"]) {
  if (!sdk[name]) throw new Error(`宿主 SDK 未导出 ${name}，请检查打包入口`);
}

const BASE = "https://index-translate.bilibili.com/v1";
const MODEL = "Index-Translate-35B-A3B";
const config = { baseUrl: BASE, model: MODEL, maxTokens: 4096 };
const service = manifest.services.find((item) => item.id === "translation");
const visionService = manifest.services.find((item) => item.id === "vision");
const logs = [];

function makeCtx(input, config, assetBuffer) {
  return {
    requestId: "sdk-check",
    config,
    resources: {},
    options: { streaming: false },
    helpers: {
      ...sdk.providerHelpers,
      translation: {
        ...sdk.providerHelpers.translation,
        ...sdk.createTranslationHelpers(input),
      },
    },
    secrets: { ref: (key) => ({ scope: "translation", key }), sign: async () => "sig" },
    http: {
      request: async (request) => {
        const init = { method: request.method ?? "GET", headers: { ...(request.headers ?? {}) } };
        if (request.bodyType === "json") init.body = JSON.stringify(request.body);
        else if (typeof request.body === "string") init.body = request.body;
        const response = await fetch(request.url, init);
        const body = await response.text();
        logs.push({ status: response.status, body: request.body });
        return { status: response.status, headers: Object.fromEntries(response.headers), body };
      },
    },
    assets: { read: async () => assetBuffer },
    emit: async () => {},
  };
}

function check(label, condition, detail) {
  if (!condition) {
    console.error(`FAIL ${label}`, detail ?? "");
    process.exitCode = 1;
    return false;
  }
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ""}`);
  return true;
}

async function timed(label, fn) {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started, label };
}

// 0) 真实宿主解析安装包（含清单、能力、提示词、字段、模型、权限、图标签名）
const zipPath = join(ROOT, "dist", `${manifest.id}-v${manifest.version}.zip`);
if (existsSync(zipPath) && sdk.readProviderPackage) {
  const pkg = sdk.readProviderPackage(new Uint8Array(readFileSync(zipPath)));
  check("宿主解析安装 ZIP", pkg.manifest.id === manifest.id, pkg.manifest.version);
}

// 1) 单条翻译：HTML + 术语
{
  const preset = service.defaultPrompts.nobatch[0];
  const input = {
    items: [{ id: "0", text: "<p>Click <b>here</b> to read the <i>API</i> docs.</p>" }],
    targetLanguage: "zh-CN",
    sourceLanguage: "en",
    translationMode: "single",
    outputProtocol: "text",
    textFormat: "html",
    glossary: { API: "接口" },
    systemPrompt: preset.systemPrompt,
    userPrompt: preset.userPrompt,
  };
  const { value, ms } = await timed("single", () => translate(input, config, makeCtx(input, config)));
  const text = value.items[0]?.text ?? "";
  check("单条翻译", /<b>.*<\/b>/.test(text) && /接口/.test(text), `${ms}ms ${text.slice(0, 120)}`);
}

// 2) 聚合翻译：ID 对齐
{
  const preset = service.defaultPrompts.batch[0];
  const input = {
    items: [
      { id: "0", text: "技术赋能创作，让交流跨越语言的界限。" },
      { id: "1", text: "今天天气真好，我们去公园散步吧。" },
    ],
    targetLanguage: "en",
    sourceLanguage: "zh-CN",
    translationMode: "batch",
    outputProtocol: "json",
    glossary: {},
    systemPrompt: preset.systemPrompt,
    userPrompt: preset.userPrompt,
  };
  const { value, ms } = await timed("batch", () => translate(input, config, makeCtx(input, config)));
  const ids = value.items.map((item) => item.id).join(",");
  check("聚合翻译", ids === "0,1" && value.items.every((item) => item.text.trim()), `${ms}ms ${ids}`);
}

// 3) 图片识别：宿主 prepareMessages + ArrayBuffer 资产
{
  const preset = visionService.defaultPrompts.vlm[0];
  const bytes = readFileSync(join(ROOT, "assets/logo.png"));
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const input = {
    image: { assetId: "asset-1", mimeType: "image/png", filename: "logo.png" },
    mode: "doc",
    imageSize: { width: 256, height: 256 },
    prompt: preset.userPrompt,
  };
  const { value, ms } = await timed("vision", () =>
    parseImage(input, { ...config, maxTokens: 512 }, makeCtx(input, { ...config, maxTokens: 512 }, arrayBuffer)),
  );
  check("图片识别", Boolean(value.text?.trim()) && value.format === "markdown", `${ms}ms ${value.text.slice(0, 80)}`);
}

process.exit(process.exitCode ?? 0);
