# dsh-site-bridge

[English](README.md) · [Русский](README.ru.md) · **中文**

**把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的眼睛和双手放进你自己的浏览器。**
把页面的结构与其 BFF 流量抓取成智能体可读的文件，用可信输入驱动页面，并在同一个标签页里验证你刚写好的扩展。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

两部分，一座桥：

| 部分 | 作用 |
|---|---|
| **DSH 插件**（`lib/`） | 维护本机回环桥接，向模型提供八个工具，并把快照包写入会话工作区。 |
| **MV3 扩展**（`extension/`） | 运行在你的 Chrome/Edge 配置中，使用你的 Cookie，通过 CDP 抓取结构与网络，用真实输入事件驱动页面。已本地化：English、Русский、中文。 |

两者缺一不可：插件承载面向模型的接口与文件，扩展承载浏览器会话与保真度。

---

## 为什么需要它

写一个嵌入别人网站的扩展，本质上是一场考古：页面结构到底是什么、哪个选择器能活过下次发版、这个按钮调用了哪个 BFF 接口、请求体长什么样。手工做这些就是 DevTools、复制粘贴和猜测。

这个项目把考古变成一次抓取：

```
site_capture → captures/<host>/<timestamp>/
  dom.html          被抓区域序列化后的结构
  dom.json          元素树：盒子、属性、选择器候选
  styles.json       关键节点的计算样式 + 主题 CSS 变量
  selectors.md      稳定选择器清单，并说明每个为什么稳定
  network.jsonl     每个抓到的 xhr/fetch，每行一个 JSON
  api.md            按 method+path 分组的接口，以及请求/响应契约
  screenshot.png    可选的整页截图
```

智能体像读普通源码一样读这些文件，然后写扩展。接着 `site_inject` 把这段代码跑在活页面上，"应该能用" 就变成 "在这里能用"。

## 功能

- **结构** —— 带盒子与可见性的元素树、交互节点的计算样式、主题 CSS 变量，以及按稳定性排序的选择器候选（`data-testid` > `id` > `name` > `aria-label` > class 路径 > 位置路径），每个都在活的 DOM 上检查过唯一性。
- **BFF 流量** —— `xhr`/`fetch` 的方法、状态、请求头、请求体、响应头、响应体，且只针对被检查的站点。
- **可信输入** —— 通过 CDP `Input.*` / `DOM.setFileInputFiles` 完成点击、输入、下拉、按键、滚动和文件上传：这些事件页面无法与真人操作区分。
- **虚拟光标** —— 一个移动到目标的 DOM 覆盖层，并在该坐标发出真实鼠标事件，用于忽略合成 `click()` 的控件。
- **深层选择器** —— `host >>> inner` 可以穿过开放的 shadow root 与同源 iframe；点击坐标会按 iframe 偏移校正。
- **后台标签页可用** —— 标签页不在前台时，读取、点击、输入和截图仍然可用（Chrome 只在后台限制定时器与动画）。
- **不保存任何凭据** —— 见[安全](#安全)。

### 与浏览器自动化插件的区别

有些插件给智能体提供 `browser_*` 工具：导航、点击、输入、读取页面。本项目不是其中之一，虽然这些都
能做——这里的输入是用来验证抓取结果的工具，而不是产品本身。

产品是抓取：带盒子与计算样式的 DOM、主题 CSS 变量、经过唯一性校验的选择器候选，以及站点自身的
xhr/fetch（含请求头与请求体），全部写成智能体可读的文件。自动化的作用是让「这个选择器可用」和
「这个 BFF 调用能带着我的 Cookie 通过」在活页面上被验证，而不是被假设。

实际后果：本项目是为编写面向某个具体网站的扩展而做的，输入工具用来在活页面上验证这些工作，而不是
用来浏览网页。

## 环境要求

- 带 `dsh` CLI 与配置档（Desktop 或 Web）的 DeepSeek Harness。
- Chrome 或 Edge 125+（扩展依赖 `chrome.debugger` 与 MV3 service worker）。
- Node.js 22+，用于 `tools/` 里的工具和测试。

## 安装

### 1. 宿主部分

```powershell
dsh plugin --profile desktop add dsh-site-bridge
```

以上会安装已发布的 npm 包。从本地克隆安装则用：

```powershell
# 在仓库根目录
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

脚本会把插件链接进你的配置档、写入 `dsh.profile.bundles`，并把扩展复制到 `%USERPROFILE%\.dsh\site-bridge\extension`。等价的手工步骤：

```powershell
dsh plugin --profile desktop add <本仓库路径>
```

如果 CLI 没写入，请把 `"dsh-site-bridge"` 加到 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 中，然后重启 DSH —— 宿主部分在配置档启动时加载。

### 2. 浏览器部分

1. `chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → `%USERPROFILE%\.dsh\site-bridge\extension`。
2. 打开扩展弹窗。它会显示端口和 `bridge.json` 的路径（`site_status` 也会打印同样内容）。
3. 点击 **导入 bridge.json**（Import bridge.json）并选择该文件，或直接粘贴令牌 —— 会自动保存，无需按钮。
4. 打开要操作的页面，点击 **连接此标签页**。

Chrome 会显示「已开始调试此浏览器」提示条：这正是全部功能所依赖的 CDP 会话。点击**断开**后消失。

弹窗界面跟随浏览器语言：英语、俄语、简体中文位于 `extension/_locales`。

## 用法

```text
site_status                     → 网桥状态、令牌路径、当前标签页
site_tabs {action:"list"}       → 标签页列表；{action:"claim", tabId} 绑定其一
site_network {action:"start"}   → 开始录制，然后在页面上操作
site_capture {screenshot:true}  → 把快照包写入工作区
site_act {steps:"[...]"}        → click/fill/type/select/press/scroll/upload/wait/eval
site_cursor {x,y,click:true}    → 虚拟光标，真实鼠标事件
site_shot {fullPage:true}       → 截图到 captures/shots/*.png
site_inject {js:"..."}          → 在页面中执行你的脚本以验证
```

编写页内扩展的典型循环：

1. `site_tabs` → 绑定页面。
2. `site_capture` → 阅读 `selectors.md`、`styles.json`、`api.md`。
3. 在你自己的仓库里写 userscript / content script。
4. 用 `site_inject` 注入脚本体 → 确认锚点能找到、BFF 调用能带着浏览器 Cookie 通过。
5. 针对快照标记为脆弱的选择器继续调整。

## 架构

```
┌──────────────────────────── DSH 宿主 ────────────────────────────┐
│  tools (site_*) ──► 网桥：127.0.0.1、令牌、long-poll 队列          │
│  写入时脱敏 ──► 内存缓冲 ──► 快照包写入                            │
└───────────────────────────────┬───────────────────────────────────┘
                                │ HTTP long-poll（不使用 websocket）
┌───────────────────────────────┴───────────────────────────────────┐
│  MV3 service worker: chrome.debugger ──► CDP                        │
│    Network domain  → 带请求头与请求体的请求                         │
│    Input domain    → 可信鼠标/键盘、文件上传                        │
│    Runtime domain  → DOM 快照、选择器、注入脚本                     │
│  popup：配对、目标标签页、录制开关（ru / en / zh）                  │
└────────────────────────────────────────────────────────────────────┘
```

协议很小，详见 [docs/protocol.md](docs/protocol.md)。

## 安全

- **凭据不离开浏览器。** 扩展不读取 Cookie 或令牌：页面自己发请求，浏览器自动附带。网桥能看到传输中的值，但 `cookie`、`authorization`、`x-csrf-token`、`x-api-key`、`set-cookie` 等请求头的值、形似凭据的查询参数与 JSON/表单字段，都会在**接收时**替换为 `«redacted»` —— 早于任何保存动作。
- **磁盘上不写任何凭据类内容。** 请求头的*名字*会保留，因为「这个接口需要 `x-csrf-token`」属于契约的一部分；值不会。
- **录制限定站点。** 只记录被检查站点自身的 `xhr`/`fetch`（同主机、同可注册域，或第三方 JSON）。把整页 HTML 转储到自己服务器的遥测与安全代理会被过滤掉 —— 否则含内联令牌的页面源码就会落进快照包。
- **仅回环。** 网桥只绑定 `127.0.0.1`，任何没有 32 字节配对令牌的请求都会被拒绝。`site_status` 打印的是令牌文件路径，而不是令牌本身。
- **残余风险。** 请求头与请求体仍会经过 DSH 进程的内存。如果站点把密钥放在非常规字段名下，脱敏无法识别。请像对待任何流量转储一样，把快照包视为敏感数据。

### 信任模型

网桥只接受携带配对令牌的请求。扩展申请 `debugger` 而不是 `<all_urls>`，也不会向每个页面注入
content script。代价是配对步骤与 Chrome 的调试提示条。换来的是：权限按标签页、按会话授予，请求在
产生的地方被读取，凭据不离开浏览器。

## 限制

跨域 iframe、封闭的 shadow root 与响应体大小上限在 [docs/limitations.md](docs/limitations.md) 中逐条分析 —— 包含代码位置、消除方案与预估成本。

## 测试

```powershell
node test\redact.test.mjs     #  8 —— 脱敏规则
node test\bridge.test.mjs     #  8 —— 协议、令牌、在线判定
node test\artifacts.test.mjs  #  5 —— 快照包布局与大体积响应体外置
node test\plugin.test.mjs     #  2 —— 工具注册与完整工具路径
node test\e2e.mjs             # 31 —— 真实 Chrome，走协议层
node test\tools-chrome.mjs    # 19 —— 真实 Chrome，走工具层
```

`e2e.mjs` 与 `tools-chrome.mjs` 会启动一次性 Chrome，通过 `Extensions.loadUnpacked` 加载扩展，并针对带真实 BFF 接口的本地页面验证抓取、可信输入、虚拟光标、文件上传、注入与截图。

## 仓库结构

```
lib/            DSH 插件：工具、网桥、脱敏、快照包写入
extension/      MV3：service worker（CDP）、弹窗、图标、多语言
docs/           协议、限制、详细指南
scripts/        install.ps1
tools/          图标栅格化、弹窗/图标预览、asar 读取（仅开发用）
test/           单元、集成、端到端
```



MIT —— 见 [LICENSE](LICENSE)。

## 版本管理

版本号保存在 `package.json`，并同步到 `extension/manifest.json`；历史记录在 `CHANGELOG.md`。
任何改动发布代码的提交都要提升版本号，仅文档的提交不需要：

```powershell
node tools\version.mjs check                  # 三个文件不一致时报错
node tools\version.mjs bump minor             # 同步更新 package.json、manifest.json 与 CHANGELOG 条目
```

发布使用 `vX.Y.Z` 标签。0.3.0 之前的版本是按提交历史回溯标注的，因此旧标签指向的内容里
可能仍写着 0.1.0。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
