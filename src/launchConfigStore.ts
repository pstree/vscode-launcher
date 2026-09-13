// ---------------------------------------------------------------------------
// launch.json 读写与模型
// 职责单一：把 launch.json 读成内存模型、写回磁盘、把原始配置转成可编辑参数。
// 不含任何 webview / UI 逻辑。
// ---------------------------------------------------------------------------
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

/** 无工作区（单文件打开 / 无 folder）时统一的 folderIndex 取值 */
export const NO_FOLDER = -1;

/** 定位一个配置所需的坐标（folderIndex + configIndex 总是成对出现） */
export interface ConfigRef {
  folderIndex: number;
  configIndex: number;
}

export interface LaunchConfigInfo extends ConfigRef {
  name: string;
  type: string;
  request: string;
  raw: Record<string, any>;
}

export interface EditableParam {
  key: string;
  value: any;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  builtin: boolean;
}

/** 判断两个 ConfigRef 是否指向同一个配置 */
export function sameRef(a: ConfigRef, b: ConfigRef): boolean {
  return a.folderIndex === b.folderIndex && a.configIndex === b.configIndex;
}

function getLaunchUri(folder?: vscode.WorkspaceFolder): vscode.Uri {
  if (folder) {
    return vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return vscode.Uri.joinPath(folders[0].uri, '.vscode', 'launch.json');
  }
  return vscode.Uri.file(path.join(os.homedir(), '.vscode', 'launch.json'));
}

export function readAllLaunchConfigs(): LaunchConfigInfo[] {
  const result: LaunchConfigInfo[] = [];
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    const cfgs = vscode.workspace.getConfiguration('launch').get<any[]>('configurations') ?? [];
    cfgs.forEach((c, i) => {
      result.push({
        name: c.name ?? 'unnamed',
        type: c.type ?? 'unknown',
        request: c.request ?? 'launch',
        raw: { ...c },
        folderIndex: NO_FOLDER,
        configIndex: i,
      });
    });
    return result;
  }

  for (let fi = 0; fi < folders.length; fi++) {
    const cfgs = vscode.workspace.getConfiguration('launch', folders[fi]).get<any[]>('configurations') ?? [];
    cfgs.forEach((c, i) => {
      result.push({
        name: c.name ?? 'unnamed',
        type: c.type ?? 'unknown',
        request: c.request ?? 'launch',
        raw: { ...c },
        folderIndex: fi,
        configIndex: i,
      });
    });
  }
  return result;
}

/** 读取某个 folder 下的原始配置数组（写回磁盘时用） */
export function readRawConfigsOfFolder(folderIndex: number): any[] {
  return readAllLaunchConfigs()
    .filter((c) => c.folderIndex === folderIndex)
    .map((c) => c.raw);
}

/** 写入 launch.json：直接覆盖文件（丢弃编辑器中未保存的更改） */
export async function writeLaunchJson(folderIndex: number, configs: any[]): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const folder = (folderIndex >= 0 && folders) ? folders[folderIndex] : undefined;
  const uri = getLaunchUri(folder);

  // 1. 如果 launch.json 在编辑器中打开且有未保存更改，先还原（丢弃更改）以避免写入冲突
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.toString() === uri.toString() && doc.isDirty) {
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
      await vscode.commands.executeCommand('workbench.action.files.revert');
      break;
    }
  }

  // 2. 直接写文件（覆盖）
  let doc: any = { version: '0.2.0', configurations: configs };
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
    doc = { ...parsed, configurations: configs };
  } catch {
    // 文件不存在或解析失败，使用默认结构
  }
  const content = JSON.stringify(doc, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

function paramTypeOf(value: unknown): EditableParam['type'] {
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return 'string';
}

const BUILTIN_KEYS = new Set(['name', 'type', 'request']);

export function configToParams(raw: Record<string, any>): EditableParam[] {
  const params: EditableParam[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.push({
      key,
      value,
      type: paramTypeOf(value),
      builtin: BUILTIN_KEYS.has(key),
    });
  }
  return params;
}
