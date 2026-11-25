# Bilibili Index-Translate · 简约翻译接口插件

把 Bilibili 开源的 **Index-Translate** 免费公开翻译接口接进[简约翻译（KISS Translator）](https://github.com/fishjar/kiss-translator)。无需 API Key，支持**单句翻译、聚合翻译、AI 提示词预设**与**图片文字识别**。

上游接口：`https://index-translate.bilibili.com/v1`（OpenAI Chat Completions 兼容）
参考实现：[bilibili/Index-Translate · call_api.py](https://github.com/bilibili/Index-Translate/blob/main/inference/llm/call_api.py)
插件协议来源：[简约翻译插件开发指南（插件 API 1）](https://github.com/fishjar/kiss-translator-plugins/blob/main/docs/plugin-development-guide.md)

> 本项目是第三方示例插件，与 Bilibili 官方无关；公共接口的限流、可用性和免费政策由提供方决定。

## 特性

| 能力 | 说明 |
| --- | --- |
| 文本翻译 | 单条 + 聚合（每批最多 8 条），完整输出，按输入 ID 对齐 |
| 模型 | `Index-Translate-35B-A3B`（默认）、`9B`、`2B`，可自填 |
| 提示词 | 内置「单条翻译」「标准单条翻译（带上下文）」「聚合翻译（JSON）」等预设，可复制后在提示词管理中改写 |
| 图片识别 | 图片原文识别、文档转 Markdown、表格、公式（不返回坐标，不做伪造 OCR 框） |
| 免费 | 清单声明 `freeTier: "free"`，默认地址不需要鉴权 |
| 依赖 | 插件脚本零依赖；仓库自带的测试/探测/桥接工具只需要 Node.js 20+ |

插件脚本只做三件事：构造上游请求、清理模型输出（`<think>`、意外代码围栏）、把文本交回宿主解析。语言、术语、上下文、聚合调度和结果校验都由宿主完成。

### 实测记录

开发时用 `npm run probe` 直接调用公开接口验证（2026-11，默认 `35B-A3B`）：

| 场景 | 结果 |
| --- | --- |
| 中→英、英→中单条翻译 | 通过 |
| 3 段聚合 JSON，ID 不串位 | 通过 |
| HTML 标签保留、术语对照生效 | 通过 |
| 图片描述（base64 `image_url`） | 通过 |
| `9B` / `2B` 模型 | 通过 |
| 上游 SSE 流式 | 可用，但公共接口偶有非翻译的闲聊回复，因此插件只声明完整输出 |

另外用宿主 **2.2.7** 的真实 `readProviderPackage` 与 SDK 跑通了安装包解析、单条翻译、聚合翻译和图片识别（见 `tools/sdk-check.mjs`）。

## 安装

### 方式一：导入文件夹（开发时最方便）

1. 打开简约翻译扩展设置 →「接口插件」。
2. 选择「导入文件夹」，选中本目录（**根部直接包含 `manifest.json`**）。
3. 完成权限确认。

### 方式二：导入 ZIP

```bash
npm run pack
# 产物：dist/bilibili-index-translate-v1.0.0.zip
```

ZIP 根部就是 `manifest.json`，可直接在「接口插件」页导入。

### 方式三：GitHub 项目地址

推送到公开仓库后，在「接口插件」中填仓库根地址（`https://github.com/<owner>/<repo>`）。安装器只认默认分支根目录的 `manifest.json`，不运行 npm 构建。

## 配置

1. 「服务配置 → 添加 → 插件接口」→ 选择 **文本翻译**。
2. 保持默认基础地址 `https://index-translate.bilibili.com/v1`（不要填到 `/chat/completions`）。
3. 选择模型；`maxTokens` 默认 4096，长文档可调到 8192/16384。
4. 保存后先跑能力测试：`chat` 用默认提示词发 `Hello`，`translate` 用一段短文本；再在网页翻译、划词、输入框等场景选择该实例。

### Origin 配置（重要）

公共网关会校验浏览器扩展发出的 `Origin`，不匹配时常见 **HTTP 412 / 403**。

| 宿主版本 | 处理方式 |
| --- | --- |
| 2.2.6 及更新 | 清单里的 `permissions.originRewrite` 会自动把发往 `https://index-translate.bilibili.com` 的请求 Origin 重写为同源，无需手工设置 |
| 2.2.5 | 「基本设置 → 禁用Origin名单」单独加一行 `https://index-translate.bilibili.com` |
| 仍被拒绝 / 需要给其他工具复用 | 使用仓库自带的本地桥接（见下文），基础地址改成 `http://127.0.0.1:8080/v1` |

`originRewrite` 必须与 `permissions.network` 中的固定 origin 完全一致，且只在实例已启用、配置有效时生效。

## 本地工具

```bash
# 直接验证公开接口（不经过宿主）
npm run probe -- "技术赋能创作，让交流跨越语言的界限。" -t en
npm run probe -- "今天天气真好，我们去公园散步吧。" -t ja --stream
npm run probe -- --image screenshot.png -t zh

# OpenAI 兼容本地桥接：宿主基础地址改 http://127.0.0.1:8080/v1
node tools/bridge.mjs
node tools/bridge.mjs --port 8787
```

桥接会补齐 `enable_thinking: false` 与 `temperature: 0`，并返回 CORS 头；默认只监听 `127.0.0.1`，无鉴权，不要随意绑定到 `0.0.0.0`。

## 目录结构

```
.
├── manifest.json              # 插件清单：权限、服务、能力、配置、默认提示词
├── services/
│   ├── translation.js         # translate handler
│   └── vision.js              # parseImage handler
├── assets/logo.png            # 由 scripts/make-icon.mjs 生成
├── scripts/
│   ├── make-icon.mjs          # 无依赖 PNG 生成
│   └── pack.mjs               # 无依赖 ZIP 打包
├── tools/
│   ├── probe.mjs              # 直连上游的调试脚本
│   ├── bridge.mjs             # 本地 OpenAI 兼容桥接
│   └── sdk-check.mjs          # 可选：用真实宿主 SDK 跑 handler
├── tests/                     # node:test：清单契约 + 脚本行为
├── README.md
└── LICENSE
```

## 开发

```bash
npm test        # 清单静态校验 + 两个 handler 的请求/清理/错误行为
npm run pack    # 打安装 ZIP
```

测试不需要宿主源码，也不访问网络：`tests/helpers.mjs` 按插件 API 1 的契约模拟了 `ctx.http`、`ctx.helpers`、`ctx.assets`。

可选的真实宿主联调（会访问公网接口）：克隆 `fishjar/kiss-translator`，用 esbuild 把 `src/providers/{package,sdk}` 打成一个 Node 可加载的模块，然后：

```bash
KISS_HOST_SDK=./host-sdk.mjs npm run sdk-check
```

它会先用宿主的 `readProviderPackage` 解析 `dist/` 里的 ZIP（清单、能力、提示词、字段、模型、权限、图标签名），再用真实 SDK 执行单条翻译、聚合翻译和图片识别。完整命令见 `tools/sdk-check.mjs` 顶部注释。

改动脚本后：

1. 提高 `manifest.json` 的 `version`，**保持插件 ID 与服务 ID 不变**；
2. 重新导入文件夹或 ZIP，在「接口插件」中更新模板；
3. 到「服务配置」升级实例（实例保存的是各自快照，不升级不会生效）。

### 上游请求要点

```js
{
  model: "Index-Translate-35B-A3B",
  messages: [...],                       // 由宿主按预设模板展开
  temperature: 0,                        // 翻译用贪心解码
  max_tokens: 4096,
  stream: false,
  chat_template_kwargs: { enable_thinking: false }
}
```

`enable_thinking: false` 是必须的：该模型被训练为直接输出译文，开启思考时 CoT 可能取代译文出现在 `content` 里。插件在清理阶段仍会剥离残留的 `<think>...</think>`。

## 排障

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 能力测试报 412 / 403 | 浏览器 Origin 被公共网关拒绝 | 按上文配置 Origin 重写/禁用名单，或改用 `tools/bridge.mjs` |
| 429 / 请求超时 | 公共接口限流 | 降低并发、关闭聚合、换 `9B`/`2B`，稍后重试 |
| 译文为空或混入推理文本 | 上游忽略 `enable_thinking` | 换模型重试；确认未被自定义提示词覆盖 |
| 聚合翻译缺项 / 报 JSON 错误 | 模型没按 JSON 输出 | 换 `35B-A3B`，或关闭实例的「聚合翻译」 |
| 输出被截断 | `maxTokens` 太小 | 调大输出上限，或拆分长文本 |
| 图片识别为空 | 模型不支持图片 / 图片过大 | 换 `35B-A3B`，压缩图片到 8 MiB 以内 |
| 改了配置没生效 | 实例使用快照 | 在服务配置中升级实例 |

## 许可与致谢

- 本仓库代码：MIT（见 `LICENSE`）。
- 上游模型与接口：[bilibili/Index-Translate](https://github.com/bilibili/Index-Translate)。
- 插件体系与协议：简约翻译项目及其[官方插件仓库](https://github.com/fishjar/kiss-translator-plugins)。官方也维护了同名 Index-Translate 插件；本项目是独立实现，用于学习和二次开发，不替代官方插件。
