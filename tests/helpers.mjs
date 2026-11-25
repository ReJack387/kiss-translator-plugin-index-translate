// 测试专用的最小 ctx 替身：只实现 SDK 中被脚本实际调用的成员。
// 行为按《网络服务插件开发指南（插件 API 1）》第 7 节描述模拟。
export function makeCtx(options = {}) {
  const {
    responseText = "你好，世界。",
    responseContent,
    response,
    requestError,
    buildMessages = () => [{ role: "user", content: "built-user-message" }],
    parseResult = (text, input) => ({
      items: (input.items ?? []).map((item) => ({ id: item.id, text })),
      sourceLanguage: input.sourceLanguage,
    }),
    textTaskMessages = [{ role: "user", content: [{ type: "text", text: "built-image-prompt" }] }],
    textTaskResult = (text) => ({
      text,
      format: "markdown",
      items: text.split(/\r?\n/).filter(Boolean).map((line) => ({ text: line, poly: null })),
    }),
    imageBytes = new Uint8Array([1, 2, 3, 4]),
  } = options;

  const calls = {
    buildRequest: [],
    prepareMessages: [],
    request: [],
    translateMessages: [],
    textTaskMessages: [],
    textTaskParse: [],
    images: [],
  };

  const ctx = {
    options: { streaming: false },
    secrets: { ref: (key) => ({ __secret: key }) },
    assets: {
      read: async (ref) => {
        calls.images.push(ref);
        return imageBytes;
      },
    },
    http: {
      request: async (request) => {
        calls.request.push(request);
        if (requestError) throw requestError;
        return response ?? { status: 200, headers: {}, body: "{}" };
      },
    },
    helpers: {
      openai: {
        chatCompletions: {
          buildRequest: (opts) => {
            calls.buildRequest.push(opts);
            return { url: `${opts.baseUrl}/chat/completions`, method: "POST", body: opts };
          },
          prepareMessages: async (messages, readAsset) => {
            calls.prepareMessages.push({ messages, readAsset });
            // 模拟宿主的 image 部件 → image_url 转换；读取必须由脚本提供的回调完成。
            const bytes = await readAsset({ assetId: "img-1", mimeType: "image/png" });
            return [{ role: "user", content: `image:${bytes.length}` }];
          },
          parseResponse: () => {
            if (responseContent !== undefined) return { text: undefined, content: responseContent };
            return { text: responseText, reasoning: "" };
          },
        },
      },
      translation: {
        buildMessages: (input) => {
          calls.translateMessages.push(input);
          return buildMessages(input);
        },
        parseResult: (text, input) => {
          calls.parseResult = { text, input };
          return parseResult(text, input);
        },
      },
      textTasks: {
        buildMessages: (task, input) => {
          calls.textTaskMessages.push({ task, input });
          return textTaskMessages;
        },
        parseResult: (task, text, input) => {
          calls.textTaskParse.push({ task, text, input });
          return textTaskResult(text);
        },
      },
    },
  };

  return { ctx, calls };
}
