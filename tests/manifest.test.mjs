// 清单与包结构自检：不依赖宿主，只校验插件 API 1 的静态契约。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

const CAPABILITIES = new Set([
  "chat",
  "translate",
  "summarize",
  "detectLanguage",
  "dictionary",
  "suggest",
  "segmentSubtitle",
  "transcribe",
  "recognizeText",
  "parseImage",
  "analyzeLayout",
  "synthesizeSpeech",
  "evaluate",
]);
const SETTING_TYPES = new Set(["text", "password", "number", "boolean", "select"]);
const FIELD_KEY = /^[A-Za-z_$][\w$]*$/;
// 第 11.2 节列出的翻译模板变量。
const TEMPLATE_VARS = new Set([
  "items",
  "segments",
  "text",
  "sourceLanguage",
  "from",
  "fromLang",
  "targetLanguage",
  "to",
  "toLang",
  "glossary",
  "context",
  "tone",
  "title",
  "description",
  "summary",
  "url",
]);

function mergedSettings(service) {
  const merged = new Map();
  for (const field of [...(manifest.sharedSettings ?? []), ...(service.settings ?? [])]) {
    assert.ok(FIELD_KEY.test(field.key), `字段键不合法：${field.key}`);
    merged.set(field.key, field);
  }
  return merged;
}

function assertSetting(field, where) {
  assert.ok(SETTING_TYPES.has(field.type), `${where}.${field.key} 类型不合法`);
  assert.equal(typeof field.label, "string", `${where}.${field.key} 缺少 label`);
  if (field.type === "number") {
    assert.equal(typeof field.defaultValue, "number", `${where}.${field.key} 默认值应为数字`);
    assert.ok(field.min <= field.max, `${where}.${field.key} min/max 反了`);
  }
  if (field.type === "boolean") {
    assert.equal(typeof field.defaultValue, "boolean", `${where}.${field.key} 默认值应为布尔`);
  }
  if (field.type === "text" || field.type === "password") {
    assert.equal(typeof field.defaultValue, "string", `${where}.${field.key} 默认值应为字符串`);
  }
  if (field.type === "select") {
    const values = (field.options ?? []).map((option) => option.value);
    assert.ok(values.length > 0, `${where}.${field.key} 缺少选项`);
    assert.ok(values.includes(field.defaultValue), `${where}.${field.key} 默认值不在选项中`);
  }
}

test("顶层字段符合插件 API 1", () => {
  assert.match(manifest.id, /^[a-z][a-z0-9-]{1,100}$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.apiVersion, 1);
  assert.ok(["free", "quota-limited", "some-models", "time-limited", undefined].includes(manifest.freeTier));
  assert.ok(Array.isArray(manifest.services) && manifest.services.length > 0);
  assert.ok(!("manifestVersion" in manifest), "不应声明 manifestVersion");
});

test("网络权限只包含合法 origin", () => {
  const network = manifest.permissions.network;
  for (const origin of network) {
    assert.match(origin, /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, `origin 不合法：${origin}`);
    assert.ok(!origin.endsWith("/"), `origin 不能带尾斜线：${origin}`);
  }
  for (const origin of manifest.permissions.originRewrite ?? []) {
    assert.ok(network.includes(origin), `originRewrite 必须同时出现在 network：${origin}`);
  }
});

test("endpointFields 指向合并后的非秘密 text 字段", () => {
  const endpoints = manifest.permissions.endpointFields ?? [];
  assert.ok(endpoints.length > 0);
  for (const key of endpoints) {
    const field = (manifest.sharedSettings ?? []).find((item) => item.key === key);
    assert.ok(field, `未声明端点字段 ${key}`);
    assert.equal(field.type, "text");
    assert.notEqual(field.isSecret, true);
  }
});

test("服务、实现入口与 handler 一致", () => {
  const serviceIds = new Set();
  for (const service of manifest.services) {
    assert.ok(!serviceIds.has(service.id), `服务 ID 重复：${service.id}`);
    serviceIds.add(service.id);
    assert.match(service.id, /^[A-Za-z][\w-]{0,100}$/);

    const entry = join(ROOT, service.implementation.entry);
    assert.ok(existsSync(entry), `实现入口不存在：${service.implementation.entry}`);
    assert.notEqual(service.implementation.kind, "native");

    assert.ok(Object.keys(service.capabilities).length > 0);
    for (const [capability, definition] of Object.entries(service.capabilities)) {
      assert.ok(CAPABILITIES.has(capability), `未知能力：${capability}`);
      assert.match(definition.handler, /^[A-Za-z_$][\w$]*$/);
      assert.ok(Array.isArray(definition.outputModes) && definition.outputModes.length > 0);
      for (const mode of definition.outputModes) assert.ok(["complete", "stream"].includes(mode));
      if (capability === "translate" && definition.batch) {
        assert.equal(typeof definition.batch.supported, "boolean");
        if (definition.batch.supported) assert.ok(definition.batch.maxItems > 0);
      }
    }

    if (service.implementation.kind === "script") {
      const moduleExports = require(entry);
      for (const definition of Object.values(service.capabilities)) {
        assert.equal(typeof moduleExports[definition.handler], "function", `${service.id} 缺少 exports.${definition.handler}`);
      }
    }

    const settings = mergedSettings(service);
    for (const field of settings.values()) assertSetting(field, service.id);

    const modelField = service.modelField ?? "model";
    if (service.models) {
      const ids = service.models.map((model) => model.id);
      assert.equal(new Set(ids).size, ids.length, `${service.id} 模型 ID 重复`);
      const field = settings.get(modelField);
      assert.ok(field, `modelField 未在配置中声明：${modelField}`);
      assert.equal(field.type, "text");
      if (service.allowCustomModel === false) {
        assert.ok(ids.includes(field.defaultValue), `默认模型不在目录中：${field.defaultValue}`);
      }
    }
  }
});

test("默认提示词槽位、协议与变量合法", () => {
  for (const service of manifest.services) {
    for (const [slot, presets] of Object.entries(service.defaultPrompts ?? {})) {
      assert.ok(Array.isArray(presets) && presets.length > 0, `${service.id}.${slot} 必须是非空数组`);
      assert.ok(["nobatch", "batch", "dictionary", "subtitle", "vlm"].includes(slot), `未知槽位：${slot}`);
      const ids = new Set();
      for (const preset of presets) {
        assert.ok(!ids.has(preset.id), `${service.id}.${slot} 预设 ID 重复：${preset.id}`);
        ids.add(preset.id);
        assert.ok(typeof preset.name === "string" && preset.name.length > 0);
        const pair = [preset.systemPrompt, preset.userPrompt];
        assert.ok(pair.some((value) => typeof value === "string" && value.trim()), `${preset.id} 两条模板都为空`);
        for (const value of pair) {
          if (typeof value !== "string") continue;
          for (const match of value.matchAll(/\{\{(\w+)\}\}/g)) {
            assert.ok(TEMPLATE_VARS.has(match[1]), `${preset.id} 使用未知变量 {{${match[1]}}}`);
          }
        }
        if (slot === "nobatch") assert.equal(preset.protocol ?? "text", "text");
        if (slot === "batch") assert.ok(["json", "line", "xml"].includes(preset.protocol ?? "json"));
      }
    }

    const translate = service.capabilities.translate;
    if (translate) {
      const batch = translate.batch;
      assert.ok(service.defaultPrompts?.batch, "声明批量翻译时应提供 batch 预设");
      if (!batch || batch.supported === false) {
        // 仍然允许保留 batch 预设，宿主会按能力拒绝多项调用。
      }
    }
  }
});

test("图标与描述符合体积/长度约束", () => {
  const icon = join(ROOT, manifest.icon);
  assert.ok(existsSync(icon));
  assert.ok(readFileSync(icon).length <= 256 * 1024, "图标超过 256 KiB");
  for (const text of [manifest.description, ...Object.values(manifest.descriptionI18n ?? {})]) {
    assert.ok([...text].length <= 1000, "描述超过 1000 个码点");
  }
});
