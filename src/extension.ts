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
    // 运行中项单击行 → 聚焦该程序的集成终端看日志（勾选框点击不会触发此命令）
    if (running) {
      this.command = { command: 'multiLauncher.focusOne', title: '查看终端', arguments: [this] };
    }
  }
}

/** 本插件启动的 session 记录 */
interface SessionEntry {
  session: vscode.DebugSession;
  jmx?: number;
  rmi?: number;
  appPort?: number;
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
  /Tomcat started on port\(s\):\s*(\d+)/i,
  /started on port\s*:?\s*(\d+)/i,
  /Started .*? on port\(s\)\s*(\d+)/i,
  /(?:Listening on|server.*?port).*?(\d+)/i,
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
      if (!isNaN(p)) {
        return p;
      }
    }
  }
  return undefined;
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

  if (cfg.type === 'java') {
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
    try {
      await vscode.debug.stopDebugging(e.session);
    } catch {
      // 忽略
    }
    if (e.terminal) {
      try {
        e.terminal.dispose();
      } catch {}
    }
  }

  // 3) 兜底：关闭任何匹配该配置名的集成终端
  const remainingTerms = findMatchingTerminals(cfg.name, unclaimedTerminal);
  for (const term of remainingTerms) {
    try {
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
              const port = extractAppPort(text, patterns);
              if (port !== undefined) {
                const entry = (sessionMap.get(name) ?? []).find((x) => x.session.id === session.id);
                if (entry && entry.appPort === undefined) {
                  entry.appPort = port;
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
        if (list.length === 0) {
          sessionMap.delete(name);
        }

        // 当调试会话结束（包含从顶部调试工具栏强行停止）时，彻底清理进程和终端
        void (async () => {
          await killProcessByMarker(name);
          if (entry.terminal) {
            try {
              entry.terminal.dispose();
            } catch {}
          }
          const terms = findMatchingTerminals(name, lastUnclaimedTerminal);
          for (const term of terms) {
            try {
              term.dispose();
            } catch {}
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
    vscode.commands.registerCommand('multiLauncher.stopOne', (item: LaunchItem) => {
      void stopConfig(item.cfg, sessionMap, lastUnclaimedTerminal);
    })
  );

  // 单击运行中项 → 聚焦该程序的集成终端
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.focusOne', async (item: LaunchItem) => {
      const entries = sessionMap.get(item.cfg.name) ?? [];
      if (entries.length === 0) {
        return;
      }
      const entry = entries[entries.length - 1];
      if (entry.terminal) {
        entry.terminal.show();
        return;
      }
      const terms = findMatchingTerminals(item.cfg.name, lastUnclaimedTerminal);
      if (terms.length > 0) {
        entry.terminal = terms[0];
        if (terms[0] === lastUnclaimedTerminal) {
          lastUnclaimedTerminal = undefined;
        }
        entry.terminal.show();
        return;
      }
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
      const targets = all.filter((c) => !unchecked.has(c.name));
      if (targets.length === 0) {
        vscode.window.showInformationMessage('请先在列表中勾选要启动的配置。');
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

