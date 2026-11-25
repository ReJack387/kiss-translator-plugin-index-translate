#!/usr/bin/env node
// 本地 OpenAI 兼容桥接：宿主/浏览器 → 本机 → Bilibili Index-Translate 公开接口。
//
// 用途：
//   1. 公共网关对浏览器扩展的 Origin 返回 412/403 时，插件把基础地址改成
//      http://127.0.0.1:8080/v1 即可绕开 Origin 校验（请求由 Node 发出）。
//   2. 给只接受 OpenAI 兼容地址的其他工具复用同一个免费接口。
//
// 用法：
//   node tools/bridge.mjs                 # 127.0.0.1:8080，上游为官方公开地址
//   node tools/bridge.mjs --port 8787
//   node tools/bridge.mjs --host 0.0.0.0  # 暴露到局域网（无鉴权，谨慎）
//
// 注意：这是无鉴权的本地转发，默认只监听回环地址。
import http from "node:http";
import { Readable } from "node:stream";

const DEFAULT_BASE = "https://index-translate.bilibili.com/v1";
const MAX_BODY = 16 * 1024 * 1024;

function parseArgs(argv) {
  const options = { port: 8080, host: "127.0.0.1", base: DEFAULT_BASE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      return value;
    };
    if (arg === "--port" || arg === "-p") options.port = Number(next());
    else if (arg === "--host") options.host = next();
    else if (arg === "--base") options.base = next();
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("端口必须是 1-65535 的整数");
  }
  return options;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  setCors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function injectDefaults(raw) {
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  // 该模型被训练为直接输出译文，思考文本可能取代译文，默认关闭。
  if (!payload.chat_template_kwargs || typeof payload.chat_template_kwargs !== "object") {
    payload.chat_template_kwargs = {};
  }
  if (payload.chat_template_kwargs.enable_thinking === undefined) {
    payload.chat_template_kwargs.enable_thinking = false;
  }
  if (payload.temperature === undefined || payload.temperature === null) {
    payload.temperature = 0;
  }
  return payload;
}

async function pipeUpstream(upstream, res) {
  setCors(res);
  const headers = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }
  // fetch 已解码 gzip，不能透传 content-encoding/content-length。
  await new Promise((resolve, reject) => {
    Readable.fromWeb(upstream.body)
      .on("error", reject)
      .on("end", resolve)
      .pipe(res);
  });
}

function createServer(options) {
  const upstreamBase = options.base.replace(/\/+$/, "");

  return http.createServer(async (req, res) => {
    setCors(res);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      sendJson(res, 200, {
        object: "list",
        data: ["Index-Translate-35B-A3B", "Index-Translate-9B", "Index-Translate-2B"].map((id) => ({
          id,
          object: "model",
          owned_by: "index-translate",
        })),
      });
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions" || path === "/v1/completions" || path === "/completions")) {
      let payload;
      try {
        payload = injectDefaults(await readBody(req));
      } catch (error) {
        sendJson(res, error.status ?? 400, { error: { message: error.message } });
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      res.on("close", () => controller.abort());
      const started = Date.now();

      try {
        const upstream = await fetch(`${upstreamBase}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Index-Translate-Client/1.0",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        await pipeUpstream(upstream, res);
        console.log(
          `${new Date().toISOString()} ${payload.model ?? "-"} ${upstream.status} ${Date.now() - started}ms${payload.stream ? " (stream)" : ""}`,
        );
      } catch (error) {
        const message = error.name === "AbortError" ? "上游请求超时或已取消" : error.message;
        if (!res.headersSent) sendJson(res, 502, { error: { message } });
        else res.destroy();
        console.error(`${new Date().toISOString()} ERROR ${message}`);
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    sendJson(res, 404, { error: { message: `未知路径：${req.method} ${path}` } });
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node tools/bridge.mjs [--port 8080] [--host 127.0.0.1] [--base https://index-translate.bilibili.com/v1]");
    return;
  }
  const server = createServer(options);
  server.listen(options.port, options.host, () => {
    const host = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
    console.log(`Index-Translate 桥接已启动：http://${host}:${options.port}/v1`);
    console.log(`上游：${options.base}`);
    console.log("简约翻译中把「API 基础地址」改为上面的地址；API Key 留空。");
  });
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

main();
