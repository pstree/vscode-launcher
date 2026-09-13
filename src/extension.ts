import * as vscode from 'vscode';
import * as net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import { l10n } from './l10n';
import { LaunchConfigEditor } from './launchConfigEditor';
import {
  parseSsListenOutput,
  parseLsofListenOutput,
  parseNetTcpConnectionCsv,
  filterExcluded,
  extractDebugPortsFromCommandLine,
} from './portParsers';

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

// ---------------------------------------------------------------------------
// 配置唯一键
// 多 folder 工作区里不同 folder 可以有同名配置，仅用 name 作键会互相串扰
// （运行态显示、停止、进程标记都会误伤），故统一使用 folder + name 复合键。
// ---------------------------------------------------------------------------

function configKey(folder: vscode.WorkspaceFolder | undefined, name: string): string {
  return `${folder?.uri.toString() ?? ''}\u0000${name}`;
}

function keyOfConfig(cfg: LaunchConfig): string {
  return configKey(cfg.folder, cfg.name);
}

/** 取 session 对应的配置键：优先用启动时写入的私有字段，兜底按 folder + name 重算 */
function keyOfSession(session: vscode.DebugSession): string {
  const stamped = (session.configuration as any)?.[KEY_FIELD];
  if (typeof stamped === 'string' && stamped.length > 0) {
    return stamped;
  }
  return configKey(session.workspaceFolder, session.configuration.name as string);
}

/** 在映射表中按 session id 反查记录 */
function findEntryBySessionId(
  sessionMap: Map<string, SessionEntry[]>,
  sessionId: string
): SessionEntry | undefined {
  for (const list of sessionMap.values()) {
    const found = list.find((e) => e.session.id === sessionId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** 运行中项要展示的应用端口：取该配置下第一个已解析出的端口 */
function firstAppPort(entries: SessionEntry[]): number | undefined {
  return entries.map((e) => e.appPort).find((p): p is number => typeof p === 'number');
}

/**
 * 扁平化 view/title 命令收到的参数并取出 LaunchItem。
 * VS Code 传参签名可能是 (items[]) / (item, items[]) / ()，故统一兜底并去重。
 */
function flattenLaunchItems(args: unknown[]): LaunchItem[] {
  const items: LaunchItem[] = [];
  const seen = new Set<string>();
  const push = (item: unknown): void => {
    if (item instanceof LaunchItem && !seen.has(item.key)) {
      seen.add(item.key);
      items.push(item);
    }
  };
  for (const arg of args) {
    if (Array.isArray(arg)) {
      arg.forEach(push);
    } else {
      push(arg);
    }
  }
  return items;
}

/** 分组节点（运行中 / 未运行） */
class GroupItem extends vscode.TreeItem {
  constructor(public readonly kind: 'running' | 'idle', public readonly count: number) {
    super(kind === 'running' ? l10n('runningCount', count) : l10n('idleCount', count),
      vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = kind === 'running' ? 'group-running' : 'group-idle';
    this.iconPath = new vscode.ThemeIcon(kind === 'running' ? 'circle-filled' : 'circle-outline');
  }
}

/** 树视图中的一项 */
class LaunchItem extends vscode.TreeItem {
  constructor(
    public readonly cfg: LaunchConfig,
    /** 全局唯一标识：folder + name，跨 folder 同名配置互不串扰 */
    public readonly key: string,
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
    this.command = { command: 'multiLauncher.focusOne', title: l10n('focusTerminal'), arguments: [this] };
  }
}

/** 本插件启动的 session 记录 */
interface SessionEntry {
  session: vscode.DebugSession;
  /** 与 sessionMap / unchecked / marker 共用的配置唯一键 */
  key: string;
  jmx?: number;
  rmi?: number;
  appPort?: number;
  portVerified?: boolean; // 端口已权威确认标志
  outputBuffer?: string;
  terminal?: vscode.Terminal;
  pollAttempts?: number; // 主动轮询尝试次数（用于退避与上限）
  pollExcluded?: Set<number>; // 需从监听端口中排除的端口集合
  jdwpChecked?: boolean; // 是否已尝试从进程命令行提取 JDWP 端口
  emptyPidStreak?: number; // 连续拿不到 PID 的轮数（用于空轮询短路）
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

/** 统一的只读外部命令执行：缺失 / 超时 / 非零退出一律返回空串，不让异常冒泡 */
async function execText(cmd: string, opts?: { maxBuffer?: number; timeout?: number }): Promise<string> {
  try {
    return String((await promisify(exec)(cmd, opts)).stdout);
  } catch {
    return '';
  }
}

/** 解析「一行一个 PID」的命令输出（pgrep / Get-CimInstance 等） */
function parsePidList(stdout: string): number[] {
  return stdout
    .split(/[\r\n]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
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

/** 批量提取这些 PID 命令行中的调试 / JMX 端口。
 *  非 Windows：一次 ps 覆盖全部 PID；Windows：保持逐个 PowerShell 查询。 */
async function collectDebugPortsFromPids(pids: number[]): Promise<number[]> {
  const ports: number[] = [];
  if (pids.length === 0) {
    return ports;
  }
  const cmdLines: string[] = [];

  if (process.platform === 'win32') {
    for (const pid of pids) {
      const out = await execText(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId = ${pid}\\").CommandLine"`
      );
      if (out) {
        cmdLines.push(out);
      }
    }
  } else {
    // 一次 ps 覆盖全部 PID；个别 PID 已退出会让 ps 非零退出，
    // 用 2>/dev/null || true 保住 stdout 中已存在的部分。
    const out = await execText(`ps -o pid=,command= -p ${pids.join(',')} 2>/dev/null || true`);
    for (const line of out.split(/[\r\n]+/)) {
      // 列序 pid=,command= → 「pid 空格 命令行」
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && m[2]) {
        cmdLines.push(m[2]);
      }
    }
  }

  for (const cmdLine of cmdLines) {
    for (const p of extractDebugPortsFromCommandLine(cmdLine)) {
      if (!ports.includes(p)) {
        ports.push(p);
      }
    }
  }
  return ports;
}

/** 查询指定 PIDs 在操作系统层面监听的 TCP 端口，返回 pid → ports 的映射。
 *  非 Windows：一次全量监听表 + 内存按 PID 过滤（避免逐 PID 串行 fork）；
 *  Windows：单条 PowerShell 按 OwningProcess 过滤（原本即单次调用，保持不动）。 */
async function getListeningPortsForPids(
  pids: number[],
  excluded: Set<number>
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  const uniquePids = Array.from(new Set(pids.filter((p) => p && p > 0)));
  if (uniquePids.length === 0) {
    return result;
  }
  const target = new Set(uniquePids);

  if (process.platform === 'win32') {
    // 合并所有 PID 为一条 PowerShell 命令查询，避免逐 PID fork powershell 进程，
    // 同时保留 OwningProcess 以便正确归属端口。
    const pidList = uniquePids.join(',');
    const netCmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess @(${pidList}) -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess, LocalPort | ConvertTo-Csv -NoTypeInformation"`;
    return filterExcluded(parseNetTcpConnectionCsv(await execText(netCmd), target), excluded);
  }

  // 外部命令统一在 execText 内降级：缺失 / 超时 / 非零退出都只返回空结果
  const opts = { maxBuffer: 4 * 1024 * 1024, timeout: 5000 };

  let map: Map<number, number[]>;
  if (process.platform === 'darwin') {
    // macOS 无 ss，用系统自带 lsof 取全量监听表（全表扫描偶发很慢，由 timeout 兜住）
    map = parseLsofListenOutput(await execText(`lsof -nP -iTCP -sTCP:LISTEN`, opts), target);
  } else {
    // Linux：ss 比 lsof 快，且一次调用即覆盖全部 PID
    const ssOut = await execText(`ss -tlnp`, opts);
    map = parseSsListenOutput(ssOut, target);
    // 仅当 ss 输出里完全没有进程信息（命令缺失 / 不支持进程列 / 权限不足）时，
    // 才整个调用级回退 lsof。若已有 pid= 只是未命中本批 PID，说明应用尚未开始监听，
    // 此时回退也查不到，反而让启动窗口内每轮多 fork 一次。
    if (!ssOut.includes('pid=')) {
      map = parseLsofListenOutput(await execText(`lsof -nP -iTCP -sTCP:LISTEN`, opts), target);
    }
  }
  return filterExcluded(map, excluded);
}

/** 查询某个进程的直接子进程 PID（Windows 走 PowerShell，其余走 pgrep -P） */
async function childPids(parentPid: number): Promise<number[]> {
  const cmd =
    process.platform === 'win32'
      ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | Select-Object -ExpandProperty ProcessId"`
      : `pgrep -P ${parentPid}`;
  return parsePidList(await execText(cmd));
}

/** 收集指定配置关联的进程 PID（marker 进程 + 集成终端进程子树） */
async function collectPidsForSession(key: string, terminal?: vscode.Terminal): Promise<number[]> {
  const pids: number[] = [];
  const markerId = getMarkerId(key);

  if (process.platform === 'win32') {
    const safeMarker = markerId.replace(/'/g, "''");
    pids.push(
      ...parsePidList(
        await execText(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'CommandLine like ''%multiLauncher.id=${safeMarker}%''' | Select-Object -ExpandProperty ProcessId"`
        )
      )
    );
  } else {
    const safeMarker = markerId.replace(/'/g, "'\\''");
    pids.push(...parsePidList(await execText(`pgrep -f 'multiLauncher.id=${safeMarker}'`)));
  }

  let termPid: number | undefined;
  try {
    termPid = await terminal?.processId;
  } catch {
    termPid = undefined; // 终端已关闭 / 拿不到 PID
  }
  if (termPid) {
    pids.push(termPid);
    // 集成终端里的真实进程是终端的（孙）子进程，向下展开两层
    const children = await childPids(termPid);
    pids.push(...children);
    for (const child of children) {
      pids.push(...(await childPids(child)));
    }
  }

  return Array.from(new Set(pids.filter((p) => p && p > 0)));
}

// ---------------------------------------------------------------------------
// 共享端口轮询器（模块级，供 activate 与 stopConfig 共用）
// 相比「每个 session 一个定时器 + 每次 fork 多次 PowerShell」，显著降低 CPU 开销：
//   - 单一 setInterval 统一轮询所有待探测 session，空闲时暂停；
//   - 一次批量并发探测，外部进程 fork 次数大幅减少。
// ---------------------------------------------------------------------------
let treeProvider: MultiLaunchProvider | undefined; // 由 activate 赋值
const pollPool = new Set<SessionEntry>(); // 待轮询的 session 集合
const POLL_MAX_ATTEMPTS = 30; // 单 session 最大探测次数（对应最长 ~90s）
const EMPTY_PID_MAX_STREAK = 5; // 连续空 PID 次数上限（约 10s 宽限期）
let pollTimer: NodeJS.Timeout | undefined;
let pollRunning = false; // 防止并发重入

/** 将 session 加入轮询池，并在空闲时启动定时器 */
function registerPolling(entry: SessionEntry): void {
  pollPool.add(entry);
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(runPolling, 2000);
}

/** 将 session 移出轮询池；无待探测项时停止定时器 */
function unregisterPolling(entry: SessionEntry): void {
  pollPool.delete(entry);
  if (pollPool.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

/** 计算某 session 当前应使用的轮询间隔（退避：2s → 4s → 6s → ...） */
function pollIntervalFor(entry: SessionEntry): number {
  const attempts = entry.pollAttempts ?? 0;
  return 2000 + Math.min(attempts, 10) * 2000;
}

/** 批量轮询：并发收集所有待探测 PID，一次性批量查询端口 */
async function runPolling(): Promise<void> {
  if (pollRunning || pollPool.size === 0) {
    return;
  }
  pollRunning = true;
  try {
    const pending = Array.from(pollPool).filter((e) => !e.portVerified);
    if (pending.length === 0) {
      return;
    }
    // 并发收集每个 session 的 PID（会 fork 外部进程），再统一批量查端口
    const pidsByName = await Promise.all(
      pending.map(async (e) => {
        const pids = await collectPidsForSession(e.key, e.terminal);
        return { entry: e, pids };
      })
    );
    const allPids = Array.from(new Set(pidsByName.flatMap((p) => p.pids)));

    // 一次批量查询所有 PID 的监听端口（Win 下合并为单条 PowerShell 命令），
    // 返回 pid → ports 映射，据此可正确区分每个 session 的端口归属。
    const allPortMap =
      allPids.length > 0 ? await getListeningPortsForPids(allPids, new Set()) : new Map<number, number[]>();

    for (const { entry, pids } of pidsByName) {
      entry.pollAttempts = (entry.pollAttempts ?? 0) + 1;

      // 终端已存在（命令已下达）却连续多轮拿不到任何 PID → 判定进程未起来或已退出，
      // 停止空轮询。编译期间终端尚未创建，不计入，故不误伤大项目的长编译。
      if (pids.length === 0) {
        if (entry.terminal) {
          entry.emptyPidStreak = (entry.emptyPidStreak ?? 0) + 1;
          if (entry.emptyPidStreak >= EMPTY_PID_MAX_STREAK) {
            unregisterPolling(entry);
            continue;
          }
        }
      } else {
        entry.emptyPidStreak = 0;
      }

      const excluded = entry.pollExcluded ?? new Set<number>();
      // 首次轮询时，从各 PID 的命令行提取 JDWP / JMX 端口并排除，
      // 避免把调试端口误判为应用端口（只做一次，降低开销）。
      if (!entry.jdwpChecked && pids.length > 0) {
        entry.jdwpChecked = true;
        for (const p of await collectDebugPortsFromPids(pids)) {
          excluded.add(p);
        }
      }
      // 汇总「属于本 session 各 PID」且未被排除的监听端口
      const ports: number[] = [];
      for (const pid of pids) {
        for (const p of allPortMap.get(pid) ?? []) {
          if (!excluded.has(p) && !ports.includes(p)) {
            ports.push(p);
          }
        }
      }
      const bestPort = selectBestAppPort(ports);
      if (bestPort !== undefined && !entry.portVerified) {
        entry.appPort = bestPort;
        treeProvider?.refresh();
      }
      // 达到上限或已权威确认 → 移出轮询池
      if (entry.portVerified || (entry.pollAttempts ?? 0) >= POLL_MAX_ATTEMPTS) {
        unregisterPolling(entry);
      }
    }
  } finally {
    pollRunning = false;
    // 还有剩余待探测项则按最短间隔继续
    if (pollPool.size > 0 && pollTimer) {
      const nextInterval = Math.min(...Array.from(pollPool).map(pollIntervalFor));
      clearInterval(pollTimer);
      pollTimer = setInterval(runPolling, Math.max(2000, nextInterval));
    }
  }
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
      const { runningItems, idleItems } = this.splitByRunning();
      return [new GroupItem('running', runningItems.length), new GroupItem('idle', idleItems.length)];
    }
    // 分组：返回该组下的配置项
    if (element instanceof GroupItem) {
      const { runningItems, idleItems } = this.splitByRunning();
      return element.kind === 'running' ? runningItems : idleItems;
    }
    return [];
  }

  /** 按运行状态切分配置项，组内按名称排序 */
  private splitByRunning(): { runningItems: LaunchItem[]; idleItems: LaunchItem[] } {
    const runningItems: LaunchItem[] = [];
    const idleItems: LaunchItem[] = [];
    for (const cfg of readAllConfigs()) {
      const key = keyOfConfig(cfg);
      const entries = this.sessionMap.get(key) ?? [];
      const running = entries.length > 0;
      // 默认全选：仅当配置键出现在 unchecked 中才视为未选中
      const item = new LaunchItem(cfg, key, running, !this.unchecked.has(key), firstAppPort(entries));
      (running ? runningItems : idleItems).push(item);
    }
    const byName = (a: LaunchItem, b: LaunchItem) => a.cfg.name.localeCompare(b.cfg.name);
    runningItems.sort(byName);
    idleItems.sort(byName);
    return { runningItems, idleItems };
  }
}

// ---------------------------------------------------------------------------
// 配置读取（仅顶层 configurations，忽略 compounds）
// ---------------------------------------------------------------------------

const LAUNCHED_BY_US = '__launchedByPlugin';
/** 启动时写入配置副本的私有字段：配置唯一键，session 起停时回读 */
const KEY_FIELD = '__key';

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

/** 将配置唯一键转换为安全、且不易碰撞的全局 PID 标记标识符 */
function getMarkerId(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return `${safe}_${hash(key)}_END`;
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

  // 回退到未认领的终端（即使已退出也保留，方便查看失败日志）
  if (matched.length === 0 && unclaimedTerminal) {
    matched.push(unclaimedTerminal);
  }

  return matched;
}

async function launchConfig(cfg: LaunchConfig, used: Set<number>): Promise<void> {
  const key = keyOfConfig(cfg);
  const resolved: vscode.DebugConfiguration = { ...cfg.raw, name: cfg.name };
  const marker = `-DmultiLauncher.id=${getMarkerId(key)}`;

  (resolved as any)[LAUNCHED_BY_US] = true;
  (resolved as any)[KEY_FIELD] = key;

  if (isJavaConfig(cfg.type)) {
    // 端口种子仍用配置名，保证同名配置重启后 JMX 端口稳定
    const { jmx, rmi } = await allocPorts(cfg.name, used);
    resolved.vmArgs = mergeVmArgs(cfg.raw.vmArgs, `${buildJmxArgs(jmx, rmi)} ${marker}`);
    // Java 程序强制使用集成终端：确保启动日志可见、端口轮询正常、失败时可查看日志
    resolved.console = 'integratedTerminal';
    (resolved as any).__jmxPort = jmx;
    (resolved as any).__rmiPort = rmi;
  }
  await vscode.debug.startDebugging(cfg.folder, resolved);
}

/** 按 multiLauncher.id 标记，在操作系统层面精准杀掉该进程（多平台） */
async function killProcessByMarker(key: string): Promise<void> {
  const marker = `multiLauncher.id=${getMarkerId(key)}`;
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
  const key = keyOfConfig(cfg);
  const entries = sessionMap.get(key) ?? [];

  // 1) 先杀掉进程（操作系统层面按唯一标记精准杀）
  await killProcessByMarker(key);

  // 2) 断开调试会话并关闭关联终端
  for (const e of entries) {
    unregisterPolling(e);
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

  sessionMap.delete(key);
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
  // 保存每个配置名最后一次关联的终端（即使 session 结束后仍可查找，方便查看失败日志）
  const lastTerminalForName = new Map<string, vscode.Terminal>();
  treeProvider = provider; // 供模块级共享轮询器刷新树视图

  // 记录本插件启动的 session
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (!(session.configuration as any)[LAUNCHED_BY_US]) {
        return;
      }
      const name = session.configuration.name as string;
      const key = keyOfSession(session);
      const list = sessionMap.get(key) ?? [];
      const entry: SessionEntry = {
        session,
        key,
        jmx: (session.configuration as any).__jmxPort,
        rmi: (session.configuration as any).__rmiPort,
      };

      const terms = findMatchingTerminals(name, lastUnclaimedTerminal);
      if (terms.length > 0) {
        entry.terminal = terms[0];
        if (terms[0] === lastUnclaimedTerminal) {
          lastUnclaimedTerminal = undefined;
        }
        lastTerminalForName.set(name, terms[0]);
      }

      list.push(entry);
      sessionMap.set(key, list);

      // 登记到共享轮询器：在操作系统层面批量探测各 session 的 TCP 监听端口
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
      entry.pollExcluded = excluded;
      entry.pollAttempts = 0;
      entry.emptyPidStreak = 0;
      registerPolling(entry);

      provider.refresh();
    })
  );

  // 将本插件起的 session 关联其集成终端
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      const tName = terminal.name.toLowerCase();
      let claimedEntry: SessionEntry | undefined;
      let claimedName: string | undefined;

      // 1) 优先匹配正在运行的 session（取最长匹配，避免短名误匹配）
      let bestLen = 0;
      for (const entries of sessionMap.values()) {
        for (const entry of entries) {
          if (entry.terminal) {
            continue;
          }
          const name = entry.session.configuration.name as string;
          const target = name.toLowerCase();
          if ((tName.includes(target) || target.includes(tName)) && name.length > bestLen) {
            claimedEntry = entry;
            claimedName = name;
            bestLen = name.length;
          }
        }
      }
      if (claimedEntry && claimedName) {
        claimedEntry.terminal = terminal;
        lastTerminalForName.set(claimedName, terminal);
        return;
      }

      // 2) session 可能尚未开始或已结束，按所有配置名匹配（取最长匹配）
      const allCfgs = readAllConfigs();
      let bestMatch: string | undefined;
      for (const cfg of allCfgs) {
        const target = cfg.name.toLowerCase();
        if ((tName.includes(target) || target.includes(tName)) && cfg.name.length > (bestMatch?.length ?? 0)) {
          bestMatch = cfg.name;
        }
      }
      if (bestMatch) {
        lastTerminalForName.set(bestMatch, terminal);
      }

      // 3) 始终存为 lastUnclaimedTerminal，供 onDidStartDebugSession 的 findMatchingTerminals 使用
      lastUnclaimedTerminal = terminal;
    })
  );

  // 通过 Debug Adapter Tracker 拦截 DAP output 事件，解析程序端口
  let patterns = getPortPatterns();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        if (!(session.configuration as any)[LAUNCHED_BY_US]) {
          return undefined; // 仅跟踪本插件启动的 session
        }
        return {
          onDidSendMessage(message: any) {
            if (message && message.type === 'event' && message.event === 'output' && message.body) {
              const text: string = message.body.output ?? '';
              if (!text) {
                return;
              }
              const entry = findEntryBySessionId(sessionMap, session.id);
              if (entry && !entry.portVerified) {
                entry.outputBuffer = (entry.outputBuffer ?? '') + text;
                if (entry.outputBuffer.length > 20000) {
                  entry.outputBuffer = entry.outputBuffer.slice(-20000);
                }
                const port = extractAppPort(entry.outputBuffer, patterns);
                if (port !== undefined) {
                  entry.appPort = port;
                  entry.portVerified = true;
                  unregisterPolling(entry);
                  provider.refresh();
                }
              }
            }
          },
        };
      },
    })
  );

  // 监听配置变更，动态更新端口模式 + 刷新树视图
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('multiLauncher.portPatterns')) {
        patterns = getPortPatterns();
      }
      if (e.affectsConfiguration('launch')) {
        provider.refresh();
      }
    })
  );

  // session 结束 → 清理进程并关闭关联终端
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      const isOurSession = (session.configuration as any)[LAUNCHED_BY_US];
      if (!isOurSession) {
        return;
      }
      const key = keyOfSession(session);
      const name = session.configuration.name as string;
      const list = sessionMap.get(key);
      if (!list) {
        return;
      }
      const idx = list.findIndex((e) => e.session.id === session.id);
      if (idx >= 0) {
        const [entry] = list.splice(idx, 1);
        unregisterPolling(entry);
        if (list.length === 0) {
          sessionMap.delete(key);
        }

        // 当调试会话结束（包含从顶部调试工具栏强行停止）时，彻底清理进程和终端
        void (async () => {
          await killProcessByMarker(key);
          // 仅「主动停止」时才关闭终端；启动失败（session 自行异常终止）时保留终端，
          // 方便用户查看失败日志。
          if (activelyStopping.has(key)) {
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
            lastTerminalForName.delete(name);
          } else {
            // 非主动停止（启动失败等）：保留终端引用，方便用户点击查看失败日志
            if (entry.terminal) {
              lastTerminalForName.set(name, entry.terminal);
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
      activelyStopping.add(item.key);
      try {
        await stopConfig(item.cfg, sessionMap, lastUnclaimedTerminal);
      } finally {
        // 延迟移除标记，避免与 onDidTerminateDebugSession 的触发时序竞争
        setTimeout(() => activelyStopping.delete(item.key), 2000);
      }
    })
  );

  // 单击任意项（运行中或已停止/启动失败）→ 聚焦该程序的集成终端查看日志
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.focusOne', async (item: LaunchItem) => {
      const entries = sessionMap.get(item.key) ?? [];

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

      // 3) 回退：使用 lastTerminalForName 中保存的终端引用（session 结束后仍保留）
      const lastTerm = lastTerminalForName.get(item.cfg.name);
      if (lastTerm) {
        try {
          lastTerm.show();
          return;
        } catch {
          // 终端可能已关闭，清理引用
          lastTerminalForName.delete(item.cfg.name);
        }
      }

      // 4) 实在没找到终端才提示
      const consoleType = (item.cfg.raw as any).console ?? 'internalConsole';
      await vscode.commands.executeCommand('workbench.debug.action.focusRepl');
      vscode.window.showInformationMessage(
        l10n('notLinkedTerminal', item.cfg.name, consoleType) + ' ' + l10n('howToLinkTerminal')
      );
    })
  );

  // 原生复选框切换：用户勾选/取消时同步到 checked 集合
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState((e) => {
      for (const [item, state] of e.items) {
        const li = item as LaunchItem;
        if (state === vscode.TreeItemCheckboxState.Checked) {
          unchecked.delete(li.key);
        } else {
          unchecked.add(li.key);
        }
      }
    })
  );

  /** 该配置当前是否有本插件启动的活跃 session */
  const isRunning = (cfg: LaunchConfig): boolean =>
    (sessionMap.get(keyOfConfig(cfg)) ?? []).length > 0;

  /** 统一分配 Java 端口（共享 used 集合）后逐个启动 */
  const launchConfigs = async (targets: LaunchConfig[]): Promise<void> => {
    const used = new Set<number>();
    for (const cfg of targets) {
      await launchConfig(cfg, used);
    }
  };

  /** 勾选且未运行的配置（复选框语义） */
  const checkedIdleConfigs = (): LaunchConfig[] =>
    readAllConfigs().filter((c) => !unchecked.has(keyOfConfig(c)) && !isRunning(c));

  // 未运行分组「运行全部」：启动所有被勾选且未运行的配置
  const launchAllIdle = async (): Promise<void> => {
    const targets = checkedIdleConfigs();
    if (targets.length === 0) {
      vscode.window.showInformationMessage(l10n('allRunning'));
      return;
    }
    await launchConfigs(targets);
  };

  // 多选启动：优先启动当前选中的项；没有选中项时退化为「勾选且未运行」
  const launchSelected = async (...args: unknown[]): Promise<void> => {
    const selected = flattenLaunchItems(args);
    if (selected.length === 0) {
      await launchAllIdle();
      return;
    }
    const targets = selected.map((i) => i.cfg).filter((c) => !isRunning(c));
    if (targets.length === 0) {
      vscode.window.showInformationMessage(l10n('allRunning'));
      return;
    }
    await launchConfigs(targets);
  };

  // 视图标题栏「启动选中项」
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.launchSelected', launchSelected)
  );

  // 未运行分组「运行全部」
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.launchAllIdle', launchAllIdle)
  );

  // 配置启动项：打开图形化配置编辑器
	  const configEditor = new LaunchConfigEditor(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.configureLaunch', () => configEditor.show())
  );

  // 停止全部：停止「运行中」分组下的所有程序
  context.subscriptions.push(
    vscode.commands.registerCommand('multiLauncher.stopAllRunning', async () => {
      // 收集所有正在运行的配置键（stopConfig 会修改 sessionMap，需先快照）
      const runningKeys = Array.from(sessionMap.keys());
      if (runningKeys.length === 0) {
        vscode.window.showInformationMessage(l10n('nothingRunning'));
        return;
      }
      const allCfgs = readAllConfigs();
      for (const key of runningKeys) {
        const cfg = allCfgs.find((c) => keyOfConfig(c) === key);
        if (!cfg) {
          // 配置可能已从 launch.json 移除，但仍需清理残留 session
          for (const e of sessionMap.get(key) ?? []) {
            unregisterPolling(e);
            try {
              await vscode.debug.stopDebugging(e.session);
            } catch {}
          }
          sessionMap.delete(key);
          continue;
        }
        activelyStopping.add(key);
        try {
          await stopConfig(cfg, sessionMap, lastUnclaimedTerminal);
        } finally {
          setTimeout(() => activelyStopping.delete(key), 2000);
        }
      }
      provider.refresh();
    })
  );
}

export function deactivate() {
  // 清理轮询定时器
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  pollPool.clear();
}

