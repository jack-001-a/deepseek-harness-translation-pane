# @ybbmm/dsh-translation-pane

面向 DeepSeek Harness 的翻译工作台：在侧边栏提供独立翻译页面，并向 Agent 提供可调用的 `translate_text` 工具。

英文文档：[README.md](README.md)

## 功能

| 位置 | 功能 |
|---|---|
| 侧边栏 | 一个 Translation 入口，在主区域打开翻译页面 |
| 翻译工作台 | 响应式原文/译文编辑区、语言与 Provider 选择、普通文本/JSON/Markdown 格式、语言交换、复制、清空、字符计数、请求取消和快捷键 |
| 术语表 | 可选的本地术语替换、语言范围、JSON 导入/导出与重叠诊断；高级编辑默认折叠 |
| Provider 故障切换 | 直连模式下，Bing 或 Google 发生可切换的服务级故障时，尝试另一个 Provider，并明确显示实际提供译文的服务 |
| Agent 工具 | `translate_text(text, targetLanguage, sourceLanguage?, format?)` |

语言、Provider 和格式偏好保存在浏览器 localStorage 中。原文、译文不会由本插件写入 localStorage。

## 安装

需要 Node.js `>=22`，以及 DeepSeek Harness `>=0.2.2-rc.4 <0.2.3-0`。该 Harness 版本范围与仓库中的固定版本运行时兼容性测试一致，并通过 `package.json` 的 `engines.dsh` 声明。

通过 Harness 插件市场搜索 **Translation Pane**，或执行：

```bash
dsh plugin add @ybbmm/dsh-translation-pane
```

本地开发目录安装：

```bash
dsh plugin add ./dsh-translation-pane
```

如果当前 profile 不支持热加载插件 bundle，请重启 Harness。

## 使用

打开侧边栏中的 **Translation**：

1. 输入或粘贴要翻译的文本。
2. 选择源语言和目标语言；源语言可设为自动检测。
3. 选择可用翻译服务及内容格式。
4. 点击 Translate，或使用 `Ctrl/⌘+Enter`（macOS 可用 Command）。
5. 复制译文；翻译过程中可点击 Cancel 或按 `Esc` 取消。

### JSON 模式

在 Format 中选择 **JSON values only**。插件会先验证 JSON，再仅将解码后的字符串值发送给翻译服务；对象键、数字、布尔值、null、层级和原始空白布局保持不变。

Agent 工具也支持：

```json
{
  "text": "{\"title\":\"Hello\",\"count\":2}",
  "targetLanguage": "zh-Hans",
  "format": "json"
}
```

默认格式仍然是普通文本。无效 JSON 会在联系 Provider 之前被拒绝。

### Markdown 模式

在 Format 中选择 **Markdown（保留文档结构）**。插件只会把普通段落、标题文本和链接标签等自然语言内容发送给翻译服务；代码围栏及代码内容、行内代码、链接目标、裸 URL、模板占位符、HTML 标签、实体和常见 Markdown 结构标记会原样保留，并在翻译后按原顺序重组。

这是一套保守的 Markdown 词法保护，不是完整的 CommonMark 解析器。项目自定义扩展或复杂嵌套链接可能需要额外适配。Agent 工具使用 `format: "markdown"` 开启同样的行为。默认仍为普通文本。

### 术语表

展开 **Terminology glossary** 可编辑术语规则。支持版本化 JSON（也兼容旧版数组）导入/导出、语言范围、大小写/整词匹配和优先级规则。Host 会提示重复或重叠术语；有警告时会自动展开该区域。

术语命中会在本地替换，不会把匹配到的原文术语发送给翻译服务。应用后的规则仅在当前 Host 会话生效；需要跨重启保留时，请导出 JSON 并写入 profile 配置。修改术语表会清理旧缓存并清空旧译文。

## 翻译通道

插件优先使用 Harness 提供的 `ctx.translator` 服务。如果该服务没有挂载，则通过匿名 Microsoft Edge/Bing 和 Google Translate 端点直连。

直连模式包括：

- 可配置的整次请求超时与单次 Provider 响应头超时。
- 对网络错误、HTTP 429 和 HTTP 5xx 的有限重试。
- Provider 故障切换与短期健康观察。
- 响应体大小上限、请求限流、LRU 缓存和相同请求合并。
- 对长文本按段落、行、句子和单词边界拆分，并发翻译后按原顺序拼接。
- 请求取消、插件卸载清理和过期响应防护。

两个 Provider 都不可用时，插件会返回明确错误，不会伪造译文。匿名端点不是受支持的稳定 API，可能限流、变更或无法从某些网络访问。

## 隐私与第三方处理

**翻译不是本地完成的。** 在直连模式下，文本会发送到实际提供翻译的 Microsoft 或 Google 端点。启用故障切换时，同一片段可能在一个 Provider 失败后发送给另一个 Provider。

普通文本模式会发送提交的文本、语言提示和请求协议元数据。JSON 模式只发送解码后的 JSON 字符串值；键名和非字符串值不会发送给翻译 Provider。

本插件不会在日志中记录原文或译文，也不会把原文和译文保存到 localStorage。但它无法保证第三方端点的日志、保留、审阅或训练政策。不要提交无权披露的凭据、个人信息或机密内容。

关闭直连故障切换可在配置中设置 `failover: false`。Harness 自带 translator 通道遵循它自身的 Provider 和账号配置。

## 配置

所有配置项都可选；无效值会回退到代码默认值。配置应写入 profile 的 `cordis.patch.yml`，以便插件更新时保留：

```yaml
- id: ybbmm-dsh-translation-pane
  name: '@ybbmm/dsh-translation-pane'
  config:
    timeoutMs: 20000
    attemptTimeoutMs: 3000
    providerCooldownMs: 300000
    failover: true
    maxTextChars: 20000
    fragmentChars: 3000
    maxRetries: 2
    retryBaseMs: 250
    retryMaxMs: 4000
    maxResponseBytes: 1048576
    cacheSize: 64
    cacheMaxBytes: 8388608
    rateLimitPerMinute: 60
    maxConcurrency: 3
    maxQueuedRequests: 24
```

完整配置项、默认值和行为说明请查看英文版 [README.md](README.md) 的 Config 章节。

## 开发与贡献

需要 Node.js 22 或更高版本：

```bash
npm run build:client # 修改 src/client 源文件后生成 client.js
npm run check        # 验证生成文件与 JavaScript 语法
npm test
```

浏览器端源码拆分在 `src/client/`：包含有序闭包片段，以及可独立导入和测试的纯业务 ES 模块。构建器会内联纯逻辑声明，再生成 Harness 使用的单文件 `client.js`。架构约定见 [客户端架构说明](docs/client-architecture.md)。

测试使用 fake Cordis context 和 stubbed fetch，不需要安装 Harness，也不会访问真实翻译服务。

- [贡献指南](CONTRIBUTING.md)
- [Harness 运行时兼容性说明](docs/harness-runtime-compatibility.md)
- [更新日志](CHANGELOG.md)

## 许可证

MIT
