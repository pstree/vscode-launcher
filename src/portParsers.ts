// ---------------------------------------------------------------------------
// 监听端口解析器
//
// 全部为无副作用的纯函数（字符串 → 数据），刻意不依赖 vscode 模块，
// 以便脱离 VS Code 运行环境用真实命令输出做对拍验证。
// ---------------------------------------------------------------------------

/** 将 pid → port 记入映射（过滤非法端口并去重） */
function addPort(map: Map<number, number[]>, pid: number, port: number): void {
  if (isNaN(port) || port <= 0 || port >= 65536) {
    return;
  }
  const list = map.get(pid) ?? [];
  if (!list.includes(port)) {
    list.push(port);
    map.set(pid, list);
  }
}

/** 解析 `ss -tlnp` 输出，返回 pid → 监听端口列表（仅保留 target 中的 PID） */
export function parseSsListenOutput(stdout: string, target: Set<number>): Map<number, number[]> {
  const result = new Map<number, number[]>();
  let current = '';
  for (const raw of stdout.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    // 部分 iproute2 版本在宽度不足时会把 users:(...) 折到下一行：
    // 非 LISTEN 开头但含 pid= 的行，拼回上一条记录后再统一解析
    if (!/^LISTEN\b/.test(line) && line.includes('pid=')) {
      current += ' ' + line;
    } else {
      current = line;
    }
    if (!current.includes('pid=')) {
      continue; // 表头等噪声行
    }
    // 解析监听端口：ss -tln 列序为 Recv-Q Send-Q Local Foreign State Process。
    // Local Address:Port 形态多样（127.0.0.1:8080 / 0.0.0.0:8080 / *:8080 / [::]:8080 /
    // fe80::1%eth0:8080），用「] 或数字或 *」后跟「:端口」来匹配本地端口；
    // Peer 列恒为 0.0.0.0:* / *:* / [::]:*（冒号后无数字），不会干扰首个匹配。
    const portMatch = /(?:\]|[0-9]|\*):(\d{1,5})\b/.exec(current);
    if (!portMatch || !portMatch[1]) {
      continue;
    }
    const port = parseInt(portMatch[1], 10);
    // 多进程共享同一 socket（cluster 模式）时一行含多个 pid=，全部收录
    for (const pm of current.matchAll(/pid=(\d+)/g)) {
      const pid = parseInt(pm[1], 10);
      if (target.has(pid)) {
        addPort(result, pid, port);
      }
    }
  }
  return result;
}

/** 解析 `lsof -nP -iTCP -sTCP:LISTEN` 输出，返回 pid → 监听端口列表 */
export function parseLsofListenOutput(stdout: string, target: Set<number>): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const raw of stdout.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith('COMMAND')) {
      continue; // 表头
    }
    // 锚定行尾的 (LISTEN)，贪婪匹配自然取到最后一个冒号后的端口，[::1]:8080 亦正确
    const portMatch = /:(\d+)\s+\(LISTEN\)\s*$/.exec(line);
    if (!portMatch || !portMatch[1]) {
      continue;
    }
    // lsof 固定列序：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const cols = line.split(/\s+/);
    const pid = parseInt(cols[1], 10);
    if (isNaN(pid) || !target.has(pid)) {
      continue;
    }
    addPort(result, pid, parseInt(portMatch[1], 10));
  }
  return result;
}

/** 解析 `Get-NetTCPConnection | ConvertTo-Csv` 输出（首行为表头，列序 OwningProcess, LocalPort） */
export function parseNetTcpConnectionCsv(stdout: string, target: Set<number>): Map<number, number[]> {
  const result = new Map<number, number[]>();
  stdout
    .split(/[\r\n]+/)
    .slice(1)
    .forEach((line) => {
      const cols = line.split(',');
      if (cols.length >= 2) {
        const pid = parseInt(cols[0].replace(/"/g, ''), 10);
        const port = parseInt(cols[1].replace(/"/g, ''), 10);
        if (!isNaN(pid) && pid > 0 && target.has(pid)) {
          addPort(result, pid, port);
        }
      }
    });
  return result;
}

/** 统一应用端口排除集（JMX / RMI / JDWP / 配置声明的调试端口） */
export function filterExcluded(
  map: Map<number, number[]>,
  excluded: Set<number>
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const [pid, ports] of map) {
    const kept = ports.filter((p) => !excluded.has(p));
    if (kept.length > 0) {
      result.set(pid, kept);
    }
  }
  return result;
}

/** 从进程命令行提取全部调试 / JMX 端口。
 *  多个 agent 时会存在多个 address=，必须逐条收集而不能只看第一个。 */
export function extractDebugPortsFromCommandLine(commandLine: string): number[] {
  const ports: number[] = [];
  const push = (raw: string) => {
    const p = parseInt(raw, 10);
    if (!isNaN(p) && p > 0 && p < 65536 && !ports.includes(p)) {
      ports.push(p);
    }
  };
  // JDWP：address=5005 / address=*:5005 / address=127.0.0.1:5005 / address=[::1]:5005。
  // 主机部分必须允许含冒号（[::1] 形态），故字符类只排除空白与逗号；
  // 贪婪匹配 + 回溯会自然停在「最后一个冒号」，避免把 IPv6 里的 :1 当成端口。
  for (const m of commandLine.matchAll(/address=(?:[^\s,]*:)?(\d+)/gi)) {
    push(m[1]);
  }
  // 兜底：万一 entry.jmx / entry.rmi 未传到，直接从命令行兜住
  for (const m of commandLine.matchAll(/jmxremote(?:\.rmi)?\.port=(\d+)/gi)) {
    push(m[1]);
  }
  return ports;
}
