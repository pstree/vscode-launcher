import * as vscode from 'vscode';
import * as net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';

// ---------------------------------------------------------------------------
// 类型与模型
// ---------------------------------------------------------------------------

/** launch.json 中的单个顶层配置（归一化后） */
interface LaunchConfig {
  name: string;
  type: string;
  folder: vscode.WorkspaceFolder | undefined;
  raw: vscode.DebugConfiguration;
}

/** 分组节点（运行中 / 未运行） */
class GroupItem extends vscode.TreeItem {
  constructor(public readonly kind: 'running' | 'idle', public readonly count: number) {
    super(kind === 'running' ? `运行中 (${count})` : `未运行 (${count})`,
      vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'group';
    this.iconPath = new vscode.ThemeIcon(kind === 'running' ? 'circle-filled' : 'circle-outline');
  }
}

/** 树视图中的一项 */
class LaunchItem extends vscode.TreeItem {
  constructor(
    public readonly cfg: LaunchConfig,
    public readonly running: boolean,
    public readonly checked: boolean,
    public readonly appPort?: number
  ) {
    super(cfg.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = running ? 'running' : 'idle';
    this.description = running ? (appPort ? `:${appPort}` : '●') : '';
    this.tooltip = `${cfg.type} · ${cfg.name}`;
    // 原生复选框（VS Code 1.63+）：点勾选框切换勾选，互不触发 command
    this.checkboxState = checked
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    // 单击行 → 聚焦该程序的集成终端看日志（运行中 / 未运行 / 启动失败均可；勾选框点击不会触发此命令）
    this.command = { command: 'multiLauncher.focusOne', title: '查看终端', arguments: [this] };
  }
}

/** 本插件启动的 session 记录 */
interface SessionEntry {
  session: vscode.DebugSession;
  jmx?: number;
  rmi?: number;
  appPort?: number;
  portVerified?: boolean; // 端口已权威确认标志
  outputBuffer?: string;
  pollTimer?: NodeJS.Timeout;
  terminal?: vscode.Terminal;
}

// ---------------------------------------------------------------------------
// 端口分配（Java 专用）
// ---------------------------------------------------------------------------

/** 稳定字符串 hash（djb2），同名永远同结果 */
function hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(h);
}

/** 探测端口是否被占用（Node net 试 bind） */
function isPortTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => {
      srv.close(() => resolve(false));
    });
    srv.listen(port, '127.0.0.1');
  });
}

/** 分配 JMX 端口对：base∈[61000,64999]，jmx=base / rmi=base+1；
 *  本批次冲突或被占用则 base+=2 重试。同名单配置端口稳定。 */
async function allocPorts(name: string, used: Set<number>): Promise<{ jmx: number; rmi: number }> {
  let base = 61000 + (hash(name) % 4000);
  while (
    used.has(base) ||
    used.has(base + 1) ||
    (await isPortTaken(base)) ||
    (await isPortTaken(base + 1))
  ) {
    base += 2;
    if (base > 64999) {
      base = 61000; // 极端情况回卷（理论不会到这）
    }
  }
  used.add(base);
  used.add(base + 1);
  return { jmx: base, rmi: base + 1 };
}

/** 构造 JMX vmArgs 片段 */
function buildJmxArgs(jmx: number, rmi: number): string {
  return (
    `-Dcom.sun.management.jmxremote.port=${jmx} ` +
    `-Dcom.sun.management.jmxremote.rmi.port=${rmi} ` +
    `-Dcom.sun.management.jmxremote.authenticate=false ` +
    `-Dcom.sun.management.jmxremote.ssl=false ` +
    `-Djava.rmi.server.hostname=127.0.0.1`
  );
}

/** 合并 vmArgs，与原配置共存，不覆盖 */
function mergeVmArgs(original: string | string[] | undefined, jmxArgs: string): string | string[] {
  if (Array.isArray(original)) {
    return [...original, jmxArgs];
  }
  if (typeof original === 'string' && original.trim().length > 0) {
    return `${original} ${jmxArgs}`;
  }
  return jmxArgs;
}

// ---------------------------------------------------------------------------
// 程序端口解析（监听 session 输出）
// ---------------------------------------------------------------------------

const DEFAULT_PORT_PATTERNS: RegExp[] = [
  /Tomcat started on port(?:\(s\))?:?\s*(\d+)/i,
  /Tomcat initialized with port(?:\(s\))?:?\s*(\d+)/i,
  /(?:Netty|Undertow|Jetty|WebServer|Web server)\s+started on port(?:\(s\))?:?\s*(\d+)/i,
  /Started \w+ in \d+.*?\bport(?:\(s\))?:?\s*(\d+)/i,
  /Started .*? on port(?:\(s\))?:?\s*(\d+)/i,
  /process running on port\s*:?\s*(\d+)/i,
  /(?:Listening on|Server started on|App running on)\s+(?:http:\/\/[^\s:]+:)?(\d+)/i,
  /(?:Local|Network):\s+http:\/\/[^\s:]+:(\d+)/i,
  /\bstarted on port(?:\(s\))?:?\s*(\d+)/i,
  /\bport(?:\(s\))?\s*[:=]?\s*(\d{2,5})\b/i,
];

function getPortPatterns(): RegExp[] {
  const cfg = vscode.workspace.getConfiguration('multiLauncher');
  const extra = cfg.get<string[]>('portPatterns', []);
  const parsed = extra
    .map((s) => {
      try {
        return new RegExp(s, 'i');
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
  return [...DEFAULT_PORT_PATTERNS, ...parsed];
}

function extractAppPort(text: string, patterns: RegExp[]): number | undefined {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) {
      const p = parseInt(m[1], 10);
      if (!isNaN(p) && p > 0 && p < 65536) {
        return p;
      }
    }
  }
  return undefined;
}

/** 从进程命令行解析 JDWP 调试端口 (address=XXXX) */
function extractJdwpPortFromCommandLine(commandLine: string): number | undefined {
  const m = /address=(?:[^\s:]+:)?(\d+)/i.exec(commandLine);
  if (m && m[1]) {
    const p = parseInt(m[1], 10);
    if (!isNaN(p) && p > 0 && p < 65536) {
      return p;
    }
  }
  return undefined;
}

/** 挑选最佳应用端口（优先 < 32768 的标准端口，排除动态高位调试端口） */
function selectBestAppPort(ports: number[]): number | undefined {
  if (ports.length === 0) {
    return undefined;
  }
  if (ports.length === 1) {
    return ports[0];
  }
  const sorted = [...ports].sort((a, b) => {
    const aEph = a >= 32768;
    const bEph = b >= 32768;
    if (aEph !== bEph) {
      return aEph ? 1 : -1;
    }
    return a - b;
  });
  return sorted[0];
}

/** 查询指定 PIDs 在操作系统层面监听的 TCP 端口 */
async function getListeningPortsForPids(pids: number[], excluded: Set<number>): Promise<number[]> {
  const ports: number[] = [];
  const uniquePids = Array.from(new Set(pids.filter((p) => p && p > 0)));
  if (uniquePids.length === 0) {
    return ports;
  }
  if (process.platform === 'win32') {
    for (const pid of uniquePids) {
      const netCmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort"`;
      try {
        const { stdout } = await promisify(exec)(netCmd);
        const pidPorts = stdout
          .split(/[\r\n]+/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n) && n > 0);
        for (const p of pidPorts) {
          if (!excluded.has(p)) {
            ports.push(p);
          }
        }
      } catch {}
    }
  } else {
    for (const pid of uniquePids) {
      try {
        const cmd = `lsof -a -p ${pid} -i -a -sTCP:LISTEN -P -n 2>/dev/null`;
        const { stdout } = await promisify(exec)(cmd);
        const matches = stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g);
        for (const m of matches) {
          const p = parseInt(m[1], 10);
          if (!isNaN(p) && !excluded.has(p)) {
            ports.push(p);
          }
        }
      } catch {}
    }
    if (ports.length === 0 && process.platform === 'linux') {
      try {
        const { stdout } = await promisify(exec)(`ss -tlnp 2>/dev/null`);
        const lines = stdout.split(/[\r\n]+/);
        for (const pid of uniquePids) {
          for (const line of lines) {
            if (line.includes(`pid=${pid},`)) {
              const match = /:(\d+)\s+/.exec(line);
              if (match && match[1]) {
                const p = parseInt(match[1], 10);
                if (!isNaN(p) && !excluded.has(p)) {
                  ports.push(p);
                }
              }
            }
          }
        }
      } catch {}
    }
  }
  return Array.from(new Set(ports));
}

/** 探测指定 session/配置名在操作系统中的 TCP 监听端口 */
async function findListeningPortsForSession(
  name: string,
  terminal?: vscode.Terminal,
  excluded: Set<number> = new Set()
): Promise<number[]> {
  const pids: number[] = [];
  const markerId = getMarkerId(name);

  if (process.platform === 'win32') {
    const safeMarker = markerId.replace(/'/g, "''");
    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'CommandLine like ''%multiLauncher.id=${safeMarker}%''' | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
    try {
      const { stdout } = await promisify(exec)(psCmd);
      if (stdout.trim()) {
        const parsed = JSON.parse(stdout);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (item.ProcessId) {
            pids.push(item.ProcessId);
          }
          if (item.CommandLine) {
            const jdwp = extractJdwpPortFromCommandLine(item.CommandLine);
            if (jdwp) {
              excluded.add(jdwp);
            }
          }
        }
      }
    } catch {}
  } else {
    const safeMarker = markerId.replace(/'/g, "'\\''");
    const cmd = `pgrep -f 'multiLauncher.id=${safeMarker}'`;
    try {
      const { stdout } = await promisify(exec)(cmd);
      const found = stdout
        .split(/[\r\n]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0);
      pids.push(...found);
      for (const pid of found) {
        try {
          const { stdout: psOut } = await promisify(exec)(`ps -p ${pid} -o command=`);
          const jdwp = extractJdwpPortFromCommandLine(psOut);
          if (jdwp) {
            excluded.add(jdwp);
          }
        } catch {}
      }
    } catch {}
  }

  if (terminal) {
    try {
      const termPid = await terminal.processId;
      if (termPid) {
        pids.push(termPid);
        if (process.platform === 'win32') {
          const c1 = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${termPid}' | Select-Object -ExpandProperty ProcessId"`;
          const { stdout: o1 } = await promisify(exec)(c1);
          const c1p = o1.split(/[\r\n]+/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
          pids.push(...c1p);
          for (const c of c1p) {
            const c2 = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${c}' | Select-Object -ExpandProperty ProcessId"`;
            try {
              const { stdout: o2 } = await promisify(exec)(c2);
              const c2p = o2.split(/[\r\n]+/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
              pids.push(...c2p);
            } catch {}
          }
        } else {
          try {
            const { stdout: o1 } = await promisify(exec)(`pgrep -P ${termPid}`);
            const c1p = o1.split(/[\r\n]+/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
            pids.push(...c1p);
            for (const c of c1p) {
              try {
                const { stdout: o2 } = await promisify(exec)(`pgrep -P ${c}`);
                const c2p = o2.split(/[\r\n]+/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
                pids.push(...c2p);
              } catch {}
            }
          } catch {}
        }
      }
    } catch {}
  }

  const uniquePids = Array.from(new Set(pids));
  return getListeningPortsForPids(uniquePids, excluded);
}

/** 判断配置类型是否为 Java / Spring Boot 项目 */
function isJavaConfig(type: string): boolean {
  if (!type) {
    return false;
  }
  const t = type.toLowerCase();
  return t === 'java' || t === 'boot' || t === 'spring-boot' || t.includes('java') || t.includes('boot');
}

// ---------------------------------------------------------------------------
// 树视图提供者
// ---------------------------------------------------------------------------

class MultiLaunchProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private sessionMap: Map<string, SessionEntry[]>,
    private unchecked: Set<string>
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    // 根：返回两个分组
    if (!element) {
      const all = readAllConfigs();
      const runningItems: LaunchItem[] = [];
      const idleItems: LaunchItem[] = [];
      for (const cfg of all) {
        const entries = this.sessionMap.get(cfg.name) ?? [];
        const running = entries.length > 0;
        const appPort = entries
          .map((e) => e.appPort)
          .find((p): p is number => typeof p === 'number');
        // 默认全选：仅当配置名在 unchecked 中才视为未选中
        const item = new LaunchItem(cfg, running, !this.unchecked.has(cfg.name), appPort);
        (running ? runningItems : idleItems).push(item);
      }
      runningItems.sort((a, b) => a.cfg.name.localeCompare(b.cfg.name));
      idleItems.sort((a, b) => a.cfg.name.localeCompare(b.cfg.name));
      return [new GroupItem('running', runningItems.length), new GroupItem('idle', idleItems.length)];
    }
    // 分组：返回该组下的配置项
    if (element instanceof GroupItem) {
      const all = readAllConfigs();
      const items: LaunchItem[] = [];
      for (const cfg of all) {
        const entries = this.sessionMap.get(cfg.name) ?? [];
        const running = entries.length > 0;
        if (running !== (element.kind === 'running')) {
          continue;
        }
        const appPort = entries
          .map((e) => e.appPort)
          .find((p): p is number => typeof p === 'number');
        items.push(new LaunchItem(cfg, running, !this.unchecked.has(cfg.name), appPort));
      }
      items.sort((a, b) => a.cfg.name.localeCompare(b.cfg.name));
      return items;
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// 配置读取（仅顶层 configurations，忽略 compounds）
// ---------------------------------------------------------------------------

const LAUNCHED_BY_US = '__launchedByPlugin';

function readAllConfigs(): LaunchConfig[] {
  const result: LaunchConfig[] = [];
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    const cfgs = vscode.workspace.getConfiguration('launch').get<any[]>('configurations') ?? [];
    for (const c of cfgs) {
      result.push({ name: c.name, type: c.type ?? 'unknown', folder: undefined, raw: c });
    }
    return result;
  }
  for (const folder of folders) {
    const cfgs =
      vscode.workspace.getConfiguration('launch', folder).get<any[]>('configurations') ?? [];
    for (const c of cfgs) {
      result.push({ name: c.name, type: c.type ?? 'unknown', folder, raw: c });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 启动 / 停止逻辑
// ---------------------------------------------------------------------------

/** 将配置名转换为安全的全局 PID 标记标识符 */
function getMarkerId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_') + '_END';
}

/** 查找匹配配置名的终端 */
function findMatchingTerminals(configName: string, unclaimedTerminal?: vscode.Terminal): vscode.Terminal[] {
  const target = configName.toLowerCase();
  const matched: vscode.Terminal[] = [];

  for (const t of vscode.window.terminals) {
    const tName = t.name.toLowerCase();
    if (tName.includes(target) || target.includes(tName)) {
      matched.push(t);
    }
  }

  if (matched.length === 0 && unclaimedTerminal && !unclaimedTerminal.exitStatus) {
    matched.push(unclaimedTerminal);
  }

  return matched;
}

async function launchConfig(cfg: LaunchConfig, used: Set<number>): Promise<void> {
  const resolved: vscode.DebugConfiguration = { ...cfg.raw, name: cfg.name };
  const markerId = getMarkerId(cfg.name);
  const marker = `-DmultiLauncher.id=${markerId}`;

  if (isJavaConfig(cfg.type)) {
    const { jmx, rmi } = await allocPorts(cfg.name, used);
    resolved.vmArgs = mergeVmArgs(cfg.raw.vmArgs, `${buildJmxArgs(jmx, rmi)} ${marker}`);
    (resolved as any)[LAUNCHED_BY_US] = true;
    (resolved as any).__jmx = jmx;
    (resolved as any).__rmi = rmi;
  } else {
    (resolved as any)[LAUNCHED_BY_US] = true;
  }
  await vscode.debug.startDebugging(cfg.folder, resolved);
}

/** 按 multiLauncher.id 标记，在操作系统层面精准杀掉该进程（多平台） */
async function killProcessByMarker(name: string): Promise<void> {
  const markerId = getMarkerId(name);
  const marker = `multiLauncher.id=${markerId}`;
  const cmd =
    process.platform === 'win32'
      ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"CommandLine like '%${marker}%'\\" | Invoke-CimMethod -MethodName Terminate"`
      : `pkill -f '${marker}'`;
  try {
    await promisify(exec)(cmd);
  } catch {
    // 找不到进程或已退出，忽略
  }
}

async function stopConfig(
  cfg: LaunchConfig,
  sessionMap: Map<string, SessionEntry[]>,
  unclaimedTerminal?: vscode.Terminal
): Promise<void> {
  const entries = sessionMap.get(cfg.name) ?? [];

  // 1) 先杀掉进程（操作系统层面按唯一标记精准杀）
  await killProcessByMarker(cfg.name);

  // 2) 断开调试会话并关闭关联终端
  for (const e of entries) {
    if (e.pollTimer) {
      clearInterval(e.pollTimer);
      e.pollTimer = undefined;
    }
    try {
      await vscode.debug.stopDebugging(e.session);
    } catch {
      // 忽略
    }
    if (e.terminal) {
      try {
        e.terminal.sendText('\x03', true); // 发送 Ctrl+C 中断信号
        e.terminal.dispose(); // 关闭集成终端
      } catch {}
    }
  }

  // 3) 兜底：关闭任何匹配该配置名的集成终端
  const remainingTerms = findMatchingTerminals(cfg.name, unclaimedTerminal);
  for (const term of remainingTerms) {
    try {
      term.sendText('\x03', true);
      term.dispose();
    } catch {}
  }

  sessionMap.delete(cfg.name);
}

// ---------------------------------------------------------------------------
// 激活
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  const sessionMap = new Map<string, SessionEntry[]>();
  const unchecked = new Set<string>(); // 默认全选，仅记录用户取消的项
  const activelyStopping = new Set<string>(); // 记录正在执行主动停止的配置，用于区分「正常停止」与「启动失败」

  const provider = new MultiLaunchProvider(sessionMap, unchecked);
  const treeView = vscode.window.createTreeView('multiLauncherView', {
    treeDataProvider: provider,
    canSelectMany: true,
  });
  context.subscriptions.push(treeView);

  let lastUnclaimedTerminal: vscode.Terminal | undefined;

  // 记录本插件启动的 session
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      const cfg = (session.configuration as any)[LAUNCHED_BY_US];
      if (!cfg) {
        return;
      }
      const name = session.configuration.name as string;
      const list = sessionMap.get(name) ?? [];
      const entry: SessionEntry = {
        session,
        jmx: (session.configuration as any).__jmx,
        rmi: (session.configuration as any).__rmi,
      };

      const terms = findMatchingTerminals(name, lastUnclaimedTerminal);
      if (terms.length > 0) {
        entry.terminal = terms[0];
        if (terms[0] === lastUnclaimedTerminal) {
          lastUnclaimedTerminal = undefined;
        }
      }

      list.push(entry);
      sessionMap.set(name, list);

      // 开启主动轮询：在操作系统层面探测该 session 的 TCP 监听端口
      // （解决 console: integratedTerminal 时 DAP 收不到日志、端口解析不到的问题）
      const excluded = new Set<number>();
      if (entry.jmx) {
        excluded.add(entry.jmx);
      }
      if (entry.rmi) {
        excluded.add(entry.rmi);
      }
      const configObj = session.configuration as any;
      if (typeof configObj.port === 'number') {
        excluded.add(configObj.port);
      }
      if (typeof configObj.debugPort === 'number') {
        excluded.add(configObj.debugPort);
      }
      if (typeof configObj.jdwpPort === 'number') {
        excluded.add(configObj.jdwpPort);
      }

      let attempts = 0;
      entry.pollTimer = setInterval(async () => {
        attempts++;
        if (entry.portVerified || attempts > 20) {
          if (entry.pollTimer) {
            clearInterval(entry.pollTimer);
            entry.pollTimer = undefined;
          }
          return;
        }
        const ports = await findListeningPortsForSession(name, entry.terminal, excluded);
        const bestPort = selectBestAppPort(ports);
        if (bestPort !== undefined && !entry.portVerified) {
          entry.appPort = bestPort;
          provider.refresh();
        }
      }, 1500);

      provider.refresh();
    })
  );

  // 将本插件起的 session 关联其集成终端
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      let claimedEntry: SessionEntry | undefined;
      for (const [name, entries] of sessionMap) {
        const target = name.toLowerCase();
        const tName = terminal.name.toLowerCase();
        if (tName.includes(target) || target.includes(tName)) {
          const entry = entries.find((e) => !e.terminal);
          if (entry && !claimedEntry) {
            claimedEntry = entry;
          }
        }
      }
      if (claimedEntry) {
        claimedEntry.terminal = terminal;
      } else {
        lastUnclaimedTerminal = terminal;
      }
    })
  );

  // 通过 Debug Adapter Tracker 拦截 DAP output 事件，解析程序端口
  const patterns = getPortPatterns();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        if (!(session.configuration as any)[LAUNCHED_BY_US]) {
          return undefined; // 仅跟踪本插件启动的 session
        }
        const name = session.configuration.name as string;
        return {
          onDidSendMessage(message: any) {
            if (message && message.type === 'event' && message.event === 'output' && message.body) {
              const text: string = message.body.output ?? '';
              if (!text) {
                return;
              }
              const entry = (sessionMap.get(name) ?? []).find((x) => x.session.id === session.id);
              if (entry && !entry.portVerified) {
                entry.outputBuffer = (entry.outputBuffer ?? '') + text;
                if (entry.outputBuffer.length > 20000) {
                  entry.outputBuffer = entry.outputBuffer.slice(-20000);
                }
                const port = extractAppPort(entry.outputBuffer, patterns);
                if (port !== undefined) {
                  entry.appPort = port;
                  entry.portVerified = true;
                  if (entry.pollTimer) {
                    clearInterval(entry.pollTimer);
                    entry.pollTimer = undefined;
                  }
                  provider.refresh();
                }
              }
            }
          },
        };
      },
    })
  );

  // session 结束 → 清理进程并关闭关联终端
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      const isOurSession = (session.configuration as any)[LAUNCHED_BY_US];
      if (!isOurSession) {
        return;
      }
      const name = session.configuration.name as string;
      const list = sessionMap.get(name);
      if (!list) {
        return;
      }
      const idx = list.findIndex((e) => e.session.id === session.id);
      if (idx >= 0) {
        const [entry] = list.splice(idx, 1);
        if (entry.pollTimer) {
          clearInterval(entry.pollTimer);
          entry.pollTimer = undefined;
        }
        if (list.length === 0) {
          sessionMap.delete(name);
        }

        // 当调试会话结束（包含从顶部调试工具栏强行停止）时，彻底清理进程和终端
        void (async () => {
          await killProcessByMarker(name);
          // 仅「主动停止」时才关闭终端；启动失败（session 自行异常终止）时保留终端，
          // 方便用户查看失败日志。
          if (activelyStopping.has(name)) {
            if (entry.terminal) {
              try {
                entry.terminal.sendText('\x03', true);
                entry.terminal.dispose();
              } catch {}
            }
            const terms = findMatchingTerminals(name, lastUnclaimedTerminal);
            for (const term of terms) {
              try {
                term.sendText('\x03', true);
                term.dispose();
              } catch {}
            }
          }
          provider.refresh();
        })();
      }
    })
  );

  // 单个启动
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.launchOne', async (item: LaunchItem) => {
      await launchConfig(item.cfg, new Set());
    })
  );

  // 单个停止
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.stopOne', async (item: LaunchItem) => {
      activelyStopping.add(item.cfg.name);
      try {
        await stopConfig(item.cfg, sessionMap, lastUnclaimedTerminal);
      } finally {
        // 延迟移除标记，避免与 onDidTerminateDebugSession 的触发时序竞争
        setTimeout(() => activelyStopping.delete(item.cfg.name), 2000);
      }
    })
  );

  // 单击任意项（运行中或已停止/启动失败）→ 聚焦该程序的集成终端查看日志
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.focusOne', async (item: LaunchItem) => {
      const entries = sessionMap.get(item.cfg.name) ?? [];

      // 1) 优先用本插件跟踪到的终端（运行中项）
      const entry = entries[entries.length - 1];
      if (entry?.terminal) {
        entry.terminal.show();
        return;
      }

      // 2) 未运行（或上次启动失败残留）时，在所有终端里按配置名匹配，
      //    启动失败的终端仍保留，可据此查看失败日志。
      const terms = findMatchingTerminals(item.cfg.name, lastUnclaimedTerminal);
      if (terms.length > 0) {
        const term = terms[0];
        if (entry) {
          entry.terminal = term;
        }
        if (term === lastUnclaimedTerminal) {
          lastUnclaimedTerminal = undefined;
        }
        term.show();
        return;
      }

      // 3) 实在没找到终端才提示
      const consoleType = (item.cfg.raw as any).console ?? 'internalConsole';
      await vscode.commands.executeCommand('workbench.debug.action.focusRepl');
      vscode.window.showInformationMessage(
        `「${item.cfg.name}」未关联集成终端（当前 console="${consoleType}"）。` +
          `如需在终端查看启动日志，请在其 launch 配置中加入 "console": "integratedTerminal"，然后重新启动。`
      );
    })
  );

  // 原生复选框切换：用户勾选/取消时同步到 checked 集合
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState((e) => {
      for (const [item, state] of e.items) {
        const li = item as LaunchItem;
        if (state === vscode.TreeItemCheckboxState.Checked) {
          unchecked.delete(li.cfg.name);
        } else {
          unchecked.add(li.cfg.name);
        }
      }
    })
  );

  // 多选启动：启动所有被勾选的项
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.launchSelected', async () => {
      const all = readAllConfigs();
      const targets = all.filter(
        (c) => !unchecked.has(c.name) && (sessionMap.get(c.name) ?? []).length === 0
      );
      if (targets.length === 0) {
        vscode.window.showInformationMessage('勾选的配置均已运行，无需重复启动。');
        return;
      }
      const used = new Set<number>();
      for (const cfg of targets) {
        await launchConfig(cfg, used);
      }
    })
  );
}

export function deactivate() {}

