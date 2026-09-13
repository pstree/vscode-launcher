// ---------------------------------------------------------------------------
// .env 文件维护
// 与 launchConfigStore 一样只负责文件读写，不含 UI 逻辑。
// 合并规则刻意做成纯函数（字符串 → 字符串），便于脱离 VS Code 验证。
// ---------------------------------------------------------------------------
import * as vscode from 'vscode';

/** 「添加环境变量」需要保证存在的默认变量 */
export const DEFAULT_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ['SPRING_PROFILES_ACTIVE', 'dev'],
  ['SPRING_OUTPUT_ANSI_ENABLED', 'ALWAYS'],
];

export interface EnvMergeResult {
  content: string;
  /** 本次实际追加的键（已存在的键不在此列） */
  added: string[];
}

/** 匹配 `KEY=` / `export KEY=`，用于收集已存在的键 */
const ENV_KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * 纯函数：把缺失的键以 `KEY=value` 追加到 .env 内容末尾。
 * 已存在的键一律不覆盖（用户手填的值优先），被注释掉的行不计入已存在。
 * 保持原有换行风格，并保证追加前有换行符分隔。
 */
export function mergeEnvContent(
  content: string,
  vars: ReadonlyArray<readonly [string, string]> = DEFAULT_ENV_VARS
): EnvMergeResult {
  const existing = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const m = ENV_KEY_RE.exec(line);
    if (m) {
      existing.add(m[1]);
    }
  }

  const missing = vars.filter(([key]) => !existing.has(key));
  if (missing.length === 0) {
    return { content, added: [] };
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const prefix = content.length === 0 || content.endsWith('\n') ? content : content + eol;
  const block = missing.map(([key, value]) => `${key}=${value}`).join(eol) + eol;
  return { content: prefix + block, added: missing.map(([key]) => key) };
}

/**
 * 为每个 workspace folder 创建 / 补齐根目录下的 `.env`
 * （与写入 launch 配置的 `envFile: ${workspaceFolder}/.env` 对应）。
 * 返回实际发生写入的 folder 数；无工作区时返回 0。
 */
export async function ensureEnvFiles(
  vars: ReadonlyArray<readonly [string, string]> = DEFAULT_ENV_VARS
): Promise<number> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return 0;
  }

  let written = 0;
  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, '.env');

    let content = '';
    try {
      content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
    } catch {
      // 文件不存在：按空内容处理，稍后创建
    }

    const merged = mergeEnvContent(content, vars);
    if (merged.added.length === 0) {
      continue;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(merged.content, 'utf-8'));
    written++;
  }
  return written;
}
