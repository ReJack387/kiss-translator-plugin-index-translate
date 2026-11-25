import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCtx } from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseImage } = require(join(ROOT, "services/vision.js"));

const BASE_CONFIG = { baseUrl: "https://index-translate.bilibili.com/v1", model: "Index-Translate-35B-A3B" };
const IMAGE = { assetId: "asset-1", mimeType: "image/png", filename: "shot.png" };

test("图片识别读取任务资产并复用文本端点", async () => {
  const { ctx, calls } = makeCtx({ responseText: "图片里的文字" });
  const input = { image: IMAGE, mode: "doc", prompt: "识别原文" };

  const result = await parseImage(input, { ...BASE_CONFIG, maxTokens: 1024 }, ctx);

  assert.equal(calls.images[0], IMAGE);
  assert.equal(calls.prepareMessages.length, 1);
  assert.deepEqual(calls.prepareMessages[0].messages, [{ role: "user", content: [{ type: "text", text: "built-image-prompt" }] }]);
  assert.equal(calls.textTaskMessages[0].task, "parseImage");
  assert.equal(calls.textTaskMessages[0].input, input);

  const request = calls.buildRequest[0];
  assert.equal(request.model, BASE_CONFIG.model);
  assert.equal(request.temperature, 0);
  assert.equal(request.max_tokens, 1024);
  assert.equal(request.stream, false);
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls.request[0].url, `${BASE_CONFIG.baseUrl}/chat/completions`);

  assert.equal(calls.textTaskParse[0].task, "parseImage");
  assert.equal(calls.textTaskParse[0].text, "图片里的文字");
  assert.equal(result.format, "markdown");
  assert.deepEqual(result.items, [{ text: "图片里的文字", poly: null }]);
});

test("识别结果同样剥离思考块", async () => {
  const { ctx, calls } = makeCtx({ responseText: "<think>ocr</think>标题" });
  await parseImage({ image: IMAGE, prompt: "识别" }, BASE_CONFIG, ctx);
  assert.equal(calls.textTaskParse[0].text, "标题");
});

test("空识别结果报错而不是返回空段落", async () => {
  const { ctx } = makeCtx({ responseText: "\n  " });
  await assert.rejects(parseImage({ image: IMAGE }, BASE_CONFIG, ctx), (thrown) => thrown.code === "EMPTY_RESPONSE");
});

test("缺图或缺少配置时提前失败", async () => {
  const { ctx } = makeCtx();
  await assert.rejects(parseImage({}, BASE_CONFIG, ctx), /缺少待识别的图片/);
  await assert.rejects(parseImage({ image: IMAGE }, { model: "m" }, ctx), /基础地址/);
  await assert.rejects(parseImage({ image: IMAGE }, { baseUrl: "https://x/v1" }, ctx), /视觉模型/);
});

test("HTTP 错误附带排障提示", async () => {
  const error = Object.assign(new Error("Request failed with status 403"), { code: "HTTP_ERROR" });
  const { ctx } = makeCtx({ requestError: error });
  await assert.rejects(parseImage({ image: IMAGE }, BASE_CONFIG, ctx), /禁用Origin名单/);
});
