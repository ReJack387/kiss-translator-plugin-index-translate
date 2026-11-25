import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCtx } from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { translate } = require(join(ROOT, "services/translation.js"));

const BASE_CONFIG = { baseUrl: "https://index-translate.bilibili.com/v1", model: "Index-Translate-35B-A3B" };

test("单条翻译按上游要求构造请求", async () => {
  const { ctx, calls } = makeCtx({ responseText: "Hello, world." });
  const input = {
    items: [{ id: "0", text: "你好，世界。" }],
    targetLanguage: "en",
    sourceLanguage: "zh-CN",
    outputProtocol: "text",
    translationMode: "single",
  };

  const result = await translate(input, { ...BASE_CONFIG, maxTokens: 2048 }, ctx);

  assert.equal(calls.translateMessages.length, 1);
  assert.equal(calls.translateMessages[0], input);

  const request = calls.buildRequest[0];
  assert.equal(request.baseUrl, BASE_CONFIG.baseUrl);
  assert.equal(request.model, BASE_CONFIG.model);
  assert.equal(request.temperature, 0, "翻译应使用贪心解码");
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.stream, false);
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(request.messages, [{ role: "user", content: "built-user-message" }]);

  assert.equal(calls.request.length, 1);
  assert.equal(calls.request[0].url, `${BASE_CONFIG.baseUrl}/chat/completions`);
  assert.equal(calls.parseResult.text, "Hello, world.");
  assert.deepEqual(result.items, [{ id: "0", text: "Hello, world." }]);
});

test("剥离 <think> 推理块，只把译文交给宿主解析", async () => {
  const { ctx, calls } = makeCtx({ responseText: "<think>先分析一下</think>真正的译文" });
  await translate({ items: [{ id: "0", text: "原文" }], targetLanguage: "en" }, BASE_CONFIG, ctx);
  assert.equal(calls.parseResult.text, "真正的译文");
});

test("聚合 JSON 输出即使被代码围栏包裹也能解析", async () => {
  const { ctx, calls } = makeCtx({
    responseText: '```json\n[{"id":"0","text":"A"},{"id":"1","text":"B"}]\n```',
  });
  const input = {
    items: [
      { id: "0", text: "甲" },
      { id: "1", text: "乙" },
    ],
    targetLanguage: "en",
    outputProtocol: "json",
    translationMode: "batch",
  };
  await translate(input, BASE_CONFIG, ctx);
  assert.equal(calls.parseResult.text, '[{"id":"0","text":"A"},{"id":"1","text":"B"}]');
  assert.equal(calls.parseResult.input, input);
});

test("单条纯文本译文不会被围栏清洗破坏", async () => {
  const { ctx, calls } = makeCtx({ responseText: "Use ```code``` here" });
  await translate({ items: [{ id: "0", text: "x" }], targetLanguage: "en", outputProtocol: "text" }, BASE_CONFIG, ctx);
  assert.equal(calls.parseResult.text, "Use ```code``` here");
});

test("maxTokens 缺失或越界时收敛到安全范围", async () => {
  for (const [configured, expected] of [
    [undefined, 4096],
    [null, 4096],
    ["", 4096],
    [1, 256],
    [999999, 16384],
    [2048, 2048],
    [2048.6, 2049],
  ]) {
    const { ctx, calls } = makeCtx();
    await translate({ items: [{ id: "0", text: "x" }], targetLanguage: "en" }, { ...BASE_CONFIG, maxTokens: configured }, ctx);
    assert.equal(calls.buildRequest[0].max_tokens, expected, `maxTokens=${configured}`);
  }
});

test("缺少基础地址或模型时给出可读错误", async () => {
  const { ctx } = makeCtx();
  await assert.rejects(
    translate({ items: [{ id: "0", text: "x" }], targetLanguage: "en" }, { model: "m" }, ctx),
    /基础地址/,
  );
  await assert.rejects(
    translate({ items: [{ id: "0", text: "x" }], targetLanguage: "en" }, { baseUrl: "https://x/v1" }, ctx),
    /模型/,
  );
});

test("上游 HTTP 错误附带 Origin/桥接提示并保留 code", async () => {
  const error = Object.assign(new Error("Request failed with status 412"), { code: "HTTP_ERROR" });
  const { ctx } = makeCtx({ requestError: error });
  await assert.rejects(
    translate({ items: [{ id: "0", text: "x" }], targetLanguage: "en" }, BASE_CONFIG, ctx),
    (thrown) => {
      assert.equal(thrown.code, "HTTP_ERROR");
      assert.match(thrown.message, /禁用Origin名单/);
      assert.match(thrown.message, /bridge\.mjs/);
      return true;
    },
  );
});

test("空译文不会伪装成成功", async () => {
  const { ctx } = makeCtx({ responseText: "   " });
  await assert.rejects(
    translate({ items: [{ id: "0", text: "x" }], targetLanguage: "en" }, BASE_CONFIG, ctx),
    (thrown) => thrown.code === "EMPTY_RESPONSE",
  );
});

test("兼容以 parts 数组返回 content 的实现", async () => {
  const { ctx, calls } = makeCtx({
    responseContent: [
      { type: "text", text: "你好" },
      { type: "text", text: "，世界" },
    ],
  });
  await translate({ items: [{ id: "0", text: "Hello, world" }], targetLanguage: "zh-CN" }, BASE_CONFIG, ctx);
  assert.equal(calls.parseResult.text, "你好，世界");
});
