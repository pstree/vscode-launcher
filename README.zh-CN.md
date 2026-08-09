# Multi Launch（多选自启动）

一个 VS Code 扩展，让你在「运行和调试」面板中**多选** `launch.json` 里的配置并**一键同时启动**。Java 类型的配置会自动注入 JMX 远程端口（随机分配、互不冲突），并在运行中显示程序自身的监听端口（如 Spring Boot 的 Tomcat 端口）。

## 功能

- **常驻多选视图**：在「运行和调试」面板下新增「多选自启动」视图，平铺列出 `launch.json` 的全部顶层配置，默认全部可见。
- **分组展示**：视图分为「运行中」与「未运行」两个分组，已启动的项归入「运行中」分组，状态一目了然。
- **自由多选**：使用 TreeView 原生复选框，勾选你想要的项，其余保持不动。
- **一键批量启动**：选中多个配置后，点击标题栏的「启动选中项」即可同时启动。
- **逐项 inline 操作**：每个配置项自带 `[▶ 启动]` / `[■ 停止]` 按钮，可单独启停。
- **单击定位输出**：单击运行中项可聚焦其集成终端，查看该程序输出。
- **Java 自动注入 JMX**：类型为 `java` 的配置启动时自动追加 JMX 远程 `vmArgs`，端口随机分配且同批次不冲突；非 Java 配置原样启动。
- **程序端口显示**：运行中项后面显示程序自身监听的端口（如 `:8080`）；抓不到则不显示（绝不编造）。JMX 调试端口不在视图显示。
- **不改磁盘**：所有注入都发生在内存中的启动配置副本上，`launch.json` 文件保持原样。
- **图形化配置编辑器**：「配置启动项」命令（`multiLauncher.configureLaunch`）打开一个 Webview 编辑器，可：
  - 浏览每个配置及其参数。
  - 编辑任意参数（字符串 / 数字 / 布尔 / 数组 / 对象），新增或删除参数，并直接保存回 `launch.json`。
  - **自动扫描项目**（「一键新增」）：检测 **Node.js**（`package.json` 的 `main` 与主入口，以及 `start`/`dev`/`serve` 脚本）、**Python**（入口文件如 `main.py`、`app.py` 等）、**Java**（含 `main` 方法的类），并自动追加为启动配置。
  - **批量添加 `envFile`**：一次性为所有配置添加 `envFile`。
  - 删除配置。
- **精准的 OS 级端口探测**：对于使用集成终端启动的 Java 程序，扩展通过查询进程实际在操作系统层面监听的 TCP 端口（`Get-NetTCPConnection` / `lsof` / `ss`）来识别应用端口，按进程正确归属，并排除调试/JMX 端口。
- **可靠的停止**：停止配置时会按唯一标记在操作系统层面精准杀掉进程，断开调试会话并关闭关联终端；启动失败的项保留终端，方便查看报错日志。

## 安装与运行（开发）

```bash
npm install

# 或 npm run watch 持续编译
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

按 `F5` 在扩展开发宿主中调试。

## 使用

1. 打开一个含 `launch.json` 的工作区。
2. 在侧边栏「运行和调试」中找到「多选自启动」视图。
3. 勾选若干配置，点击标题栏 ▶「启动选中项」；或点击某项右侧的 `▶` 单独启动。
4. 运行中项显示 `●` 及程序端口（如 `:8080`），点击 `■` 停止。
5. 点击视图标题栏的「配置启动项」（齿轮图标）打开图形化编辑器，进行添加、编辑或扫描配置。

> 注意：只有经本扩展启动的 session 才会出现在「运行中」分组并被「停止」管理。从原生「运行和调试」面板手动启动的同名配置不会被本扩展接管。

## 配置项

在设置中可调整：

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| `multiLauncher.portPatterns` | 用于从程序输出中解析端口的正则表达式字符串数组（附加在默认规则之后） | `[]` |

默认端口解析规则（按序匹配第一个命中）：

- `Tomcat started on port(s): <port>`（Spring Boot）
- `Tomcat initialized with port(s): <port>`
- `(Netty|Undertow|Jetty|WebServer) started on port(s): <port>`
- `Started ... on port(s) <port>`
- `Listening on ... <port>` / `Server started on ... <port>` / `App running on ... <port>`
- `Local: http://...:<port>` / `Network: http://...:<port>`
- 通用兜底：`started on port ... <port>` / `port: <port>` / `port=<port>`

## 端口分配规则（Java）

- 基址 `base = 61000 + (hash(配置名) % 4000)`，落在 `61000–64999`。
- `jmx = base`，`rmi = base + 1`。
- 同一次批量启动内若与其他配置冲突，或端口已被本机占用，则 `base += 2` 重试，直到空闲。
- 同名配置重启时 `hash` 稳定，端口保持一致；同批次多选时允许偏移避让以保证不冲突。
- 不做跨会话持久化（每次启动重新探测）。

## 应用端口探测

当 Java 配置在集成终端中启动时，Debug Adapter Protocol 可能无法转发程序的标准输出，导致无法仅从日志解析端口。扩展改为：

1. 通过唯一标记（`-DmultiLauncher.id=...`）识别启动进程及其子进程。
2. 查询操作系统层面这些 PID 拥有的 TCP **LISTEN** 套接字（Windows 用 `Get-NetTCPConnection`，macOS/Linux 用 `lsof` / `ss`）。
3. 排除已知的调试/JMX 端口以及从进程命令行中提取的 JDWP 端口，再挑选最佳候选端口（优先 `< 32768` 的标准端口）。

若通过 DAP tracker 从日志中解析到端口，则优先采用并停止 OS 轮询。

## 适用范围

- 仅支持 `launch.json` 的**顶层** `configurations`，不支持 `compounds`（组合配置）。
- 需要 VS Code `>= 1.84`（TreeView `multiSelect` 与复选框所需）。
