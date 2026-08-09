import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface LaunchConfigInfo {
  name: string;
  type: string;
  request: string;
  raw: Record<string, any>;
  folderIndex: number;
  configIndex: number;
}

interface EditableParam {
  key: string;
  value: any;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  builtin: boolean;
}

// ---------------------------------------------------------------------------
// Webview 消息协议
// ---------------------------------------------------------------------------

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'selectConfig'; configIndex: number; folderIndex: number }
  | { type: 'deleteConfig'; configIndex: number; folderIndex: number }
  | { type: 'addConfig' }
  | { type: 'saveConfig'; configIndex: number; folderIndex: number; raw: Record<string, any> }
  | { type: 'addEnvFileToAll' };

type ExtensionMessage =
  | { type: 'configList'; configs: LaunchConfigInfo[] }
  | { type: 'configDetail'; config: LaunchConfigInfo; params: EditableParam[] }
  | { type: 'saved'; configIndex: number; folderIndex: number }
  | { type: 'envFileAdded' }
  | { type: 'configDeleted'; configIndex: number; folderIndex: number };

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

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

function readAllLaunchConfigs(): LaunchConfigInfo[] {
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
        folderIndex: -1,
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

/** 写入 launch.json：先直接写文件，再同步 VS Code 内存配置 */
async function writeLaunchJson(folderIndex: number, configs: any[]): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const folder = (folderIndex >= 0 && folders) ? folders[folderIndex] : undefined;
  const uri = getLaunchUri(folder);

  // 1. 直接写文件
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

  // 2. 同步 VS Code 内存中的配置
  const target = folder
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
  const launchConfig = folder
    ? vscode.workspace.getConfiguration('launch', folder)
    : vscode.workspace.getConfiguration('launch');
  await launchConfig.update('configurations', configs, target);
}

function configToParams(raw: Record<string, any>): EditableParam[] {
  const params: EditableParam[] = [];
  const builtinKeys = new Set(['name', 'type', 'request']);

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) {
      continue;
    }
    let paramType: EditableParam['type'] = 'string';
    if (typeof value === 'number') {
      paramType = 'number';
    } else if (typeof value === 'boolean') {
      paramType = 'boolean';
    } else if (Array.isArray(value)) {
      paramType = 'array';
    } else if (typeof value === 'object') {
      paramType = 'object';
    }

    params.push({
      key,
      value,
      type: paramType,
      builtin: builtinKeys.has(key),
    });
  }

  return params;
}

// ---------------------------------------------------------------------------
// 项目扫描：自动检测可启动项
// ---------------------------------------------------------------------------

interface ScannedConfig {
  name: string;
  type: string;
  raw: Record<string, any>;
}

/** 扫描工作区，检测可启动项并生成 launch 配置 */
async function scanProjectForLaunchConfigs(): Promise<ScannedConfig[]> {
  const results: ScannedConfig[] = [];
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return results;

  for (const folder of folders) {
    // 1. Node.js: 读取 package.json
    try {
      const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
      const pkgData = await vscode.workspace.fs.readFile(pkgUri);
      const pkg = JSON.parse(Buffer.from(pkgData).toString('utf-8'));
      const projectDir = '${workspaceFolder}';

      if (pkg.main) {
        results.push({
          name: `Node: ${pkg.name || 'app'}`,
          type: 'node',
          raw: {
            type: 'node',
            request: 'launch',
            name: `Node: ${pkg.name || 'app'}`,
            program: `${projectDir}/${pkg.main}`,
            skipFiles: ['<node_internals>/**'],
          },
        });
      }

      if (pkg.scripts) {
        for (const [scriptName] of Object.entries(pkg.scripts)) {
          if (['start', 'dev', 'serve'].includes(scriptName)) {
            results.push({
              name: `npm: ${scriptName}`,
              type: 'node',
              raw: {
                type: 'node',
                request: 'launch',
                name: `npm: ${scriptName}`,
                runtimeExecutable: 'npm',
                runtimeArgs: ['run', scriptName],
                cwd: projectDir,
              },
            });
          }
        }
      }
    } catch {
      // 无 package.json，跳过
    }

    // 2. Python: 查找入口文件
    try {
      const pyFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*.py'),
        '**/{node_modules,.venv,venv,__pycache__}/**',
        100
      );
      const entryNames = ['main.py', 'app.py', 'run.py', 'server.py', 'manage.py', 'start.py'];
      for (const f of pyFiles) {
        const fname = f.path.split('/').pop() || '';
        if (entryNames.includes(fname)) {
          const rel = vscode.workspace.asRelativePath(f, false);
          results.push({
            name: `Python: ${fname}`,
            type: 'python',
            raw: {
              type: 'python',
              request: 'launch',
              name: `Python: ${fname}`,
              program: `\${workspaceFolder}/${rel}`,
              console: 'integratedTerminal',
            },
          });
        }
      }
    } catch {
      // 跳过
    }

    // 3. Java: 查找 main 方法类
    try {
      const javaFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*.java'),
        '**/{target,build,node_modules,.git}/**',
        200
      );
      for (const f of javaFiles) {
        try {
          const content = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf-8');
          if (!/public\s+static\s+void\s+main\s*\(/.test(content)) continue;

          // 提取包名
          const pkgMatch = content.match(/package\s+([\w.]+)\s*;/);
          // 提取类名
          const classMatch = content.match(/public\s+(?:final\s+)?class\s+(\w+)/);
          if (!classMatch) continue;

          const className = classMatch[1];
          const fqn = pkgMatch ? `${pkgMatch[1]}.${className}` : className;

          // 避免重复
          if (results.some(r => r.raw.mainClass === fqn)) continue;

          results.push({
            name: `Java: ${className}`,
            type: 'java',
            raw: {
              type: 'java',
              request: 'launch',
              name: `Java: ${className}`,
              mainClass: fqn,
              console: 'integratedTerminal',
            },
          });
        } catch {
          // 单个文件读取失败，跳过
        }
      }
    } catch {
      // 跳过
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Webview HTML 内容
// ---------------------------------------------------------------------------

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Launch 配置编辑器</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border);
      --sidebar-bg: var(--vscode-sideBar-background);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --button-secondary-bg: var(--vscode-button-secondaryBackground);
      --button-secondary-fg: var(--vscode-button-secondaryForeground);
      --button-secondary-hover: var(--vscode-button-secondaryHoverBackground);
      --list-hover: var(--vscode-list-hoverBackground);
      --list-active: var(--vscode-list-activeSelectionBackground);
      --list-active-fg: var(--vscode-list-activeSelectionForeground);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --focus-border: var(--vscode-focusBorder);
      --desc-fg: var(--vscode-descriptionForeground);
      --danger: #d73a49;
      --success: #28a745;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
      height: 100vh;
      overflow: hidden;
    }

    .app { display: flex; height: 100vh; }

    /* ===== 左侧边栏 ===== */
    .sidebar {
      width: 300px;
      min-width: 200px;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-header {
      padding: 10px 14px;
      font-weight: 600;
      font-size: 13px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .sidebar-header .add-btn {
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      padding: 3px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
    }
    .sidebar-header .add-btn:hover { background: var(--button-hover); }

    .config-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }

    .config-item {
      display: flex;
      align-items: center;
      padding: 9px 14px;
      cursor: pointer;
      border-left: 3px solid transparent;
      gap: 6px;
      transition: background 0.1s;
      user-select: none;
    }
    .config-item:hover { background: var(--list-hover); }
    .config-item.selected {
      background: var(--list-active);
      color: var(--list-active-fg);
      border-left-color: var(--focus-border);
    }
    .config-item .expand-icon {
      font-size: 10px;
      width: 14px;
      flex-shrink: 0;
      text-align: center;
      transition: transform 0.15s;
      opacity: 0.6;
    }
    .config-item .expand-icon.expanded { transform: rotate(90deg); }
    .config-item .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .config-item .type-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      opacity: 0.7;
      flex-shrink: 0;
    }
    .config-item .item-actions {
      display: flex;
      gap: 1px;
      opacity: 0;
      transition: opacity 0.1s;
    }
    .config-item:hover .item-actions { opacity: 1; }
    .config-item .item-actions button {
      background: none;
      border: none;
      color: var(--fg);
      cursor: pointer;
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 12px;
      opacity: 0.7;
      font-family: inherit;
    }
    .config-item .item-actions button:hover { opacity: 1; background: var(--list-hover); }
    .config-item .item-actions .delete-btn:hover { color: var(--danger); }

    /* 展开的参数子列表 */
    .param-sub-list {
      overflow: hidden;
    }
    .param-sub-item {
      display: flex;
      align-items: center;
      padding: 4px 14px 4px 36px;
      font-size: 12px;
      color: var(--desc-fg);
      gap: 6px;
    }
    .param-sub-item .param-sub-key {
      font-weight: 500;
      color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
      flex-shrink: 0;
    }
    .param-sub-item .param-sub-val {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.7;
    }

    .empty-list {
      padding: 24px 16px;
      text-align: center;
      color: var(--desc-fg);
      font-size: 13px;
    }

    /* ===== 右侧详情 ===== */
    .detail {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .detail-header {
      padding: 10px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .detail-header .config-name {
      font-weight: 600;
      font-size: 15px;
      flex: 1;
    }
    .detail-header .config-type {
      font-size: 12px;
      color: var(--desc-fg);
    }
    .save-btn {
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      padding: 8px 24px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      font-weight: 500;
      width: 100%;
    }
    .save-btn:hover { background: var(--button-hover); }
    .save-btn.dirty {
      background: var(--success);
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.75; }
    }

    .detail-empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--desc-fg);
      font-size: 14px;
    }

    .params-list {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
    }

    .param-group {
      margin-bottom: 20px;
    }
    .param-group-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--desc-fg);
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }

    .param-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 8px;
      padding: 8px 10px;
      border-radius: 4px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.05));
    }
    .param-row:hover { background: var(--list-hover); }

    .param-key {
      width: 120px;
      min-width: 80px;
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
      padding-top: 5px;
      word-break: break-all;
    }
    .param-key.builtin { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }

    .param-value-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .param-value-area input,
    .param-value-area select {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 4px 8px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      width: 100%;
    }
    .param-value-area input:focus {
      outline: 1px solid var(--focus-border);
      border-color: var(--focus-border);
    }

    .kv-pair {
      display: flex;
      gap: 4px;
      align-items: center;
      margin-bottom: 3px;
    }
    .kv-pair input { flex: 1; }
    .kv-pair .kv-sep {
      font-size: 11px;
      color: var(--desc-fg);
      flex-shrink: 0;
    }
    .kv-pair .kv-remove {
      background: none;
      border: none;
      color: var(--danger);
      cursor: pointer;
      font-size: 13px;
      padding: 2px 4px;
      border-radius: 3px;
      font-family: inherit;
      opacity: 0.5;
      flex-shrink: 0;
    }
    .kv-pair .kv-remove:hover { opacity: 1; background: rgba(215,58,73,0.15); }

    .array-item {
      display: flex;
      gap: 4px;
      align-items: center;
      margin-bottom: 3px;
    }
    .array-item input { flex: 1; }
    .array-item .arr-remove {
      background: none;
      border: none;
      color: var(--danger);
      cursor: pointer;
      font-size: 13px;
      padding: 2px 4px;
      border-radius: 3px;
      font-family: inherit;
      opacity: 0.5;
      flex-shrink: 0;
    }
    .array-item .arr-remove:hover { opacity: 1; background: rgba(215,58,73,0.15); }

    .mini-btn-row {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }
    .mini-btn-row button {
      background: var(--button-secondary-bg);
      color: var(--button-secondary-fg);
      border: none;
      padding: 3px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
    }
    .mini-btn-row button:hover { background: var(--button-secondary-hover); }

    .param-actions {
      display: flex;
      gap: 2px;
      padding-top: 4px;
    }
    .param-actions button {
      background: none;
      border: none;
      color: var(--danger);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 12px;
      font-family: inherit;
      opacity: 0;
      transition: opacity 0.1s;
    }
    .param-row:hover .param-actions button { opacity: 0.7; }
    .param-row:hover .param-actions button:hover { opacity: 1; background: rgba(215,58,73,0.15); }
    .param-actions button:disabled { opacity: 0.3 !important; cursor: not-allowed; }

    .add-param-section {
      margin-top: 16px;
      padding: 12px;
      border: 1px dashed var(--border);
      border-radius: 4px;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .add-param-section input {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 5px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-family: inherit;
    }
    .add-param-section input:focus { outline: 1px solid var(--focus-border); }
    .add-param-section button {
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      padding: 5px 14px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
      font-family: inherit;
    }
    .add-param-section button:hover { background: var(--button-hover); }

    .toast {
      position: fixed;
      bottom: 16px;
      right: 16px;
      background: var(--vscode-notifications-background);
      color: var(--vscode-notifications-foreground);
      border: 1px solid var(--vscode-notifications-border);
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 12px;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s;
      pointer-events: none;
      z-index: 100;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { border-color: var(--danger); }
  </style>
</head>
<body>
  <div class="app">
    <!-- 左侧配置列表 -->
    <div class="sidebar">
      <div class="sidebar-header">
        <span>启动配置</span>
        <button class="add-btn" id="addEnvFileBtn" title="为所有启动项添加 envFile" style="margin-right:4px;">批量添加envFile</button>
        <button class="add-btn" id="addConfigBtn" title="扫描项目并自动添加启动配置">一键新增</button>
      </div>
      <div class="config-list" id="configList">
        <div class="empty-list">加载中...</div>
      </div>
    </div>

    <!-- 右侧参数详情 -->
    <div class="detail">
      <div class="detail-header" id="detailHeader">
        <span class="config-name">选择左侧配置</span>
      </div>
      <div class="detail-empty" id="detailEmpty">
        请从左侧列表选择一个启动配置来编辑其参数
      </div>
      <div class="params-list" id="paramsList" style="display:none;"></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const vscode = acquireVsCodeApi();

    // ===== 状态 =====
    let configs = [];
    let selectedFolderIndex = -1;
    let selectedConfigIndex = -1;
    let currentParams = [];     // 当前显示的参数（来自文件或上次保存）
    let dirty = false;          // 是否有未保存的修改
    let expandedConfigs = {};   // 左侧展开状态：key = folderIndex:configIndex

    // ===== DOM 引用 =====
    const $ = (id) => document.getElementById(id);
    const configList = $('configList');
    const detailHeader = $('detailHeader');
    const detailEmpty = $('detailEmpty');
    const paramsList = $('paramsList');
    const toast = $('toast');

    // ===== Toast =====
    let toastTimer;
    function showToast(msg, isError) {
      toast.textContent = msg;
      toast.className = 'toast' + (isError ? ' error' : '') + ' show';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2500);
    }

    // ===== 工具函数 =====
    function escHtml(text) {
      const d = document.createElement('div');
      d.textContent = String(text);
      return d.innerHTML;
    }

    function escJsKey(k) {
      return String(k).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
    }

    function summaryVal(v) {
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') {
        if (Array.isArray(v)) return '[' + v.length + ']';
        const keys = Object.keys(v);
        return '{' + (keys.length > 3 ? keys.slice(0,3).join(', ') + ', ...' : keys.join(', ')) + '}';
      }
      const s = String(v);
      return s.length > 30 ? s.slice(0, 30) + '...' : s;
    }

    // ===== 渲染左侧列表 =====
    function renderConfigList() {
      if (configs.length === 0) {
        configList.innerHTML = '<div class="empty-list">暂无启动配置</div>';
        return;
      }

      const getExpKey = (fi, ci) => fi + ':' + ci;

      let html = '';
      for (const cfg of configs) {
        const isSel = cfg.folderIndex === selectedFolderIndex && cfg.configIndex === selectedConfigIndex;
        const expKey = getExpKey(cfg.folderIndex, cfg.configIndex);
        const isExpanded = !!expandedConfigs[expKey];
        const params = configToParamsLocal(cfg.raw);
        const extraParams = params.filter(p => !p.builtin);

        html += '<div class="config-item' + (isSel ? ' selected' : '') + '"'
          + ' data-folder="' + cfg.folderIndex + '"'
          + ' data-index="' + cfg.configIndex + '"'
          + ' data-action="select">'
          + '<span class="expand-icon' + (isExpanded ? ' expanded' : '') + '" data-action="toggle-expand">' + (extraParams.length > 0 ? '▶' : '') + '</span>'
          + '<span class="name" title="' + escHtml(cfg.name) + '">' + escHtml(cfg.name) + '</span>'
          + '<span class="type-badge">' + escHtml(cfg.type) + '</span>'
          + '<span class="item-actions">'
          + '<button data-action="delete-config" title="删除">✕</button>'
          + '</span>'
          + '</div>';

        if (isExpanded && extraParams.length > 0) {
          html += '<div class="param-sub-list">';
          for (const p of extraParams) {
            html += '<div class="param-sub-item">'
              + '<span class="param-sub-key">' + escHtml(p.key) + ':</span>'
              + '<span class="param-sub-val">' + escHtml(summaryVal(p.value)) + '</span>'
              + '</div>';
          }
          html += '</div>';
        }
      }

      configList.innerHTML = html;
    }

    function configToParamsLocal(raw) {
      const params = [];
      const builtinKeys = new Set(['name', 'type', 'request']);
      for (const [key, value] of Object.entries(raw)) {
        if (value === undefined || value === null) continue;
        let type = 'string';
        if (typeof value === 'number') type = 'number';
        else if (typeof value === 'boolean') type = 'boolean';
        else if (Array.isArray(value)) type = 'array';
        else if (typeof value === 'object') type = 'object';
        params.push({ key, value, type, builtin: builtinKeys.has(key) });
      }
      return params;
    }

    // ===== 渲染右侧参数详情 =====
    function renderParams(params, keepDirty) {
      currentParams = params.map(p => ({...p})); // 深拷贝一级
      if (!keepDirty) { dirty = false; }

      const selectedCfg = configs.find(
        c => c.folderIndex === selectedFolderIndex && c.configIndex === selectedConfigIndex
      );
      if (selectedCfg) {
        detailHeader.innerHTML =
          '<span class="config-name">' + escHtml(selectedCfg.name) + '</span>'
          + '<span class="config-type">' + escHtml(selectedCfg.type) + ' · ' + escHtml(selectedCfg.request) + '</span>';
      }

      detailEmpty.style.display = 'none';
      paramsList.style.display = 'block';

      const builtinParams = params.filter(p => p.builtin);
      const extraParams = params.filter(p => !p.builtin);

      let html = '';

      if (builtinParams.length > 0) {
        html += '<div class="param-group"><div class="param-group-title">基本属性</div>';
        html += builtinParams.map(p => renderParamRow(p, true)).join('');
        html += '</div>';
      }

      html += '<div class="param-group"><div class="param-group-title">其他参数</div>';
      if (extraParams.length === 0) {
        html += '<div style="color:var(--vscode-descriptionForeground);font-size:12px;padding:8px;">暂无额外参数</div>';
      } else {
        html += extraParams.map(p => renderParamRow(p, false)).join('');
      }
      html += renderAddParamSection(currentParams.map(p => p.key));
      html += '</div>';

      // 保存按钮放在添加参数下面
      html += '<div style="margin-top:16px;">'
        + '<button class="save-btn" id="saveBtn">保存</button>'
        + '</div>';

      paramsList.innerHTML = html;
    }

    function renderParamRow(param, isBuiltin) {
      const keyClass = isBuiltin ? 'param-key builtin' : 'param-key';
      const deleteDisabled = isBuiltin ? ' disabled' : '';

      return '<div class="param-row" data-param-key="' + escHtml(param.key) + '">'
        + '<span class="' + keyClass + '" title="' + escHtml(param.key) + '">' + escHtml(param.key) + '</span>'
        + '<div class="param-value-area">'
        + renderValueEditor(param)
        + '</div>'
        + '<div class="param-actions">'
        + '<button data-action="delete-param" data-param-key="' + escHtml(param.key) + '"' + deleteDisabled + ' title="' + (isBuiltin ? '内置字段不可删除' : '删除此参数') + '">✕</button>'
        + '</div>'
        + '</div>';
    }

    function renderValueEditor(param) {
      switch (param.type) {
        case 'string':
          return '<input type="text" value="' + escHtml(String(param.value)) + '" data-action="change-param" data-param-key="' + escHtml(param.key) + '" data-param-type="string" />';

        case 'number':
          return '<input type="number" value="' + param.value + '" data-action="change-param" data-param-key="' + escHtml(param.key) + '" data-param-type="number" />';

        case 'boolean':
          return '<select data-action="change-param" data-param-key="' + escHtml(param.key) + '" data-param-type="boolean">'
            + '<option value="true"' + (param.value === true ? ' selected' : '') + '>true</option>'
            + '<option value="false"' + (param.value === false ? ' selected' : '') + '>false</option>'
            + '</select>';

        case 'array':
          return renderArrayEditor(param.key, param.value);

        case 'object':
          return renderObjectEditor(param.key, param.value);

        default:
          return '<input type="text" value="' + escHtml(JSON.stringify(param.value)) + '" data-action="change-param" data-param-key="' + escHtml(param.key) + '" data-param-type="string" />';
      }
    }

    function renderArrayEditor(key, arr) {
      if (!Array.isArray(arr) || arr.length === 0) {
        return '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">空数组</div>'
          + '<div class="mini-btn-row"><button data-action="add-array-item" data-param-key="' + escHtml(key) + '">+ 添加</button></div>';
      }
      let html = '';
      for (let i = 0; i < arr.length; i++) {
        html += '<div class="array-item">'
          + '<input type="text" value="' + escHtml(String(arr[i])) + '" data-action="change-array-item" data-param-key="' + escHtml(key) + '" data-arr-index="' + i + '" />'
          + '<button class="arr-remove" data-action="remove-array-item" data-param-key="' + escHtml(key) + '" data-arr-index="' + i + '">✕</button>'
          + '</div>';
      }
      html += '<div class="mini-btn-row"><button data-action="add-array-item" data-param-key="' + escHtml(key) + '">+ 添加</button></div>';
      return html;
    }

    function renderObjectEditor(key, obj) {
      if (typeof obj !== 'object' || obj === null) {
        return '<input type="text" value="' + escHtml(JSON.stringify(obj)) + '" data-action="change-param" data-param-key="' + escHtml(key) + '" data-param-type="string" />';
      }
      const entries = Object.entries(obj);
      if (entries.length === 0) {
        return '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">空对象</div>'
          + '<div class="mini-btn-row"><button data-action="add-kv-pair" data-param-key="' + escHtml(key) + '">+ 添加键值</button></div>';
      }
      let html = '';
      for (const [k, v] of entries) {
        html += '<div class="kv-pair" data-param-key="' + escHtml(key) + '" data-kv-key="' + escHtml(k) + '">'
          + '<input type="text" value="' + escHtml(k) + '" placeholder="键" data-action="change-kv-key" data-param-key="' + escHtml(key) + '" data-old-key="' + escHtml(k) + '" />'
          + '<span class="kv-sep">:</span>'
          + '<input type="text" value="' + escHtml(String(v)) + '" placeholder="值" data-action="change-kv-value" data-param-key="' + escHtml(key) + '" data-kv-key="' + escHtml(k) + '" />'
          + '<button class="kv-remove" data-action="remove-kv-pair" data-param-key="' + escHtml(key) + '" data-kv-key="' + escHtml(k) + '">✕</button>'
          + '</div>';
      }
      html += '<div class="mini-btn-row"><button data-action="add-kv-pair" data-param-key="' + escHtml(key) + '">+ 添加键值</button></div>';
      return html;
    }

    function renderAddParamSection(existingKeys) {
      const allOptions = [
        'envFile', 'args', 'vmArgs', 'env', 'cwd', 'console',
        'runtimeArgs', 'program', 'mainClass', 'module', 'projectName',
        'preLaunchTask', 'postDebugTask', 'stopOnEntry', 'internalConsoleOptions'
      ];
      const existing = new Set(existingKeys || []);
      const available = allOptions.filter(k => !existing.has(k));
      let options = '';
      if (available.length === 0) {
        options = '<option value="" disabled>所有常用参数已添加</option>';
      } else {
        options = available.map(k => '<option value="' + k + '">' + k + '</option>').join('');
      }
      return '<div class="add-param-section">'
        + '<select id="newParamKey" style="flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:5px 8px;border-radius:3px;font-size:12px;font-family:inherit;">'
        + options
        + '</select>'
        + '<button id="addParamBtn">添加参数</button>'
        + '</div>';
    }

    // ===== 参数操作（本地修改 + 标记 dirty） =====
    function getParam(key) {
      return currentParams.find(p => p.key === key);
    }

    function markDirty() {
      dirty = true;
      const btn = $('saveBtn');
      if (btn) {
        btn.textContent = '保存 *';
        btn.className = 'save-btn dirty';
      }
    }

    function markClean() {
      dirty = false;
      const btn = $('saveBtn');
      if (btn) {
        btn.textContent = '保存';
        btn.className = 'save-btn';
      }
    }

    function changeParamValue(key, type, rawValue) {
      let value = rawValue;
      if (type === 'number') {
        value = parseFloat(rawValue);
        if (isNaN(value)) return;
      } else if (type === 'boolean') {
        value = rawValue === 'true';
      }
      const p = getParam(key);
      if (p) {
        p.value = value;
        markDirty();
      }
    }

    function addArrayItem(key) {
      const p = getParam(key);
      if (!p || !Array.isArray(p.value)) return;
      p.value = [...p.value, ''];
      markDirty();
      renderParams(currentParams, true);
    }

    function removeArrayItem(key, index) {
      const p = getParam(key);
      if (!p || !Array.isArray(p.value)) return;
      p.value = p.value.filter((_, i) => i !== index);
      markDirty();
      renderParams(currentParams, true);
    }

    function changeArrayItem(key, index, val) {
      const p = getParam(key);
      if (!p || !Array.isArray(p.value)) return;
      p.value = p.value.map((v, i) => i === index ? val : v);
      markDirty();
    }

    function addKvPair(key) {
      const p = getParam(key);
      if (!p || typeof p.value !== 'object' || p.value === null) return;
      const newKey = 'KEY_' + (Object.keys(p.value).length + 1);
      p.value = { ...p.value, [newKey]: '' };
      markDirty();
      renderParams(currentParams, true);
    }

    function removeKvPair(key, k) {
      const p = getParam(key);
      if (!p || typeof p.value !== 'object') return;
      const newObj = { ...p.value };
      delete newObj[k];
      p.value = newObj;
      markDirty();
      renderParams(currentParams, true);
    }

    function changeKvKey(key, oldKey, newKey) {
      const p = getParam(key);
      if (!p || typeof p.value !== 'object') return;
      if (oldKey === newKey) return;
      const newObj = {};
      for (const [k, v] of Object.entries(p.value)) {
        newObj[k === oldKey ? newKey : k] = v;
      }
      p.value = newObj;
      markDirty();
      renderParams(currentParams, true);
    }

    function changeKvValue(key, k, rawValue) {
      const p = getParam(key);
      if (!p || typeof p.value !== 'object') return;
      let value = rawValue;
      if (rawValue === 'true') value = true;
      else if (rawValue === 'false') value = false;
      else if (/^-?\\d+(\\.\\d+)?$/.test(rawValue)) value = parseFloat(rawValue);
      p.value = { ...p.value, [k]: value };
      markDirty();
    }

    function deleteParam(key) {
      const p = getParam(key);
      if (p && p.builtin) {
        showToast('内置字段不可删除', true);
        return;
      }
      currentParams = currentParams.filter(pp => pp.key !== key);
      markDirty();
      renderParams(currentParams, true);
    }

    function addNewParam() {
      const select = $('newParamKey');
      if (!select) return;
      const key = select.value;
      if (!key) {
        showToast('请选择参数名', true);
        return;
      }
      if (currentParams.some(p => p.key === key)) {
        showToast('参数 "' + key + '" 已存在', true);
        return;
      }
      // 智能默认值
      let defaultValue = '';
      if (key === 'envFile') defaultValue = '$' + '{workspaceFolder}/.env';
      else if (key === 'env') defaultValue = {};
      else if (key === 'args' || key === 'runtimeArgs') defaultValue = [];
      else if (key === 'cwd') defaultValue = '$' + '{workspaceFolder}';
      else if (key === 'console') defaultValue = 'integratedTerminal';
      else if (key === 'stopOnEntry') defaultValue = false;

      let type = 'string';
      if (typeof defaultValue === 'object') {
        type = Array.isArray(defaultValue) ? 'array' : 'object';
      }

      currentParams.push({ key, value: defaultValue, type, builtin: false });
      select.selectedIndex = 0;
      markDirty();
      renderParams(currentParams, true);
      showToast('已添加参数 "' + key + '"（点击保存生效）');
    }

    // ===== 保存 =====
    function doSave() {
      const raw = {};
      for (const p of currentParams) {
        raw[p.key] = p.value;
      }
      vscode.postMessage({
        type: 'saveConfig',
        configIndex: selectedConfigIndex,
        folderIndex: selectedFolderIndex,
        raw: raw
      });
    }

    // ===== 选择配置 =====
    function selectConfig(folderIndex, configIndex) {
      selectedFolderIndex = folderIndex;
      selectedConfigIndex = configIndex;
      dirty = false;
      renderConfigList();
      vscode.postMessage({ type: 'selectConfig', configIndex, folderIndex });
    }

    // ===== 事件委托 =====
    document.getElementById('configList').addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;

      // 找到所在的 config-item
      const item = target.closest('.config-item');
      const folder = item ? parseInt(item.dataset.folder) : -1;
      const index = item ? parseInt(item.dataset.index) : -1;

      switch (action) {
        case 'select':
          selectConfig(folder, index);
          break;
        case 'toggle-expand':
          e.stopPropagation();
          const expKey = folder + ':' + index;
          expandedConfigs[expKey] = !expandedConfigs[expKey];
          renderConfigList();
          break;
        case 'delete-config':
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteConfig', configIndex: index, folderIndex: folder });
          break;
      }
    });

    document.getElementById('paramsList').addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const pkey = target.dataset.paramKey;

      switch (action) {
        case 'delete-param':
          deleteParam(pkey);
          break;
        case 'add-array-item':
          addArrayItem(pkey);
          break;
        case 'remove-array-item':
          removeArrayItem(pkey, parseInt(target.dataset.arrIndex));
          break;
        case 'add-kv-pair':
          addKvPair(pkey);
          break;
        case 'remove-kv-pair':
          removeKvPair(pkey, target.dataset.kvKey);
          break;
      }
    });

    document.getElementById('paramsList').addEventListener('change', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const pkey = target.dataset.paramKey;

      switch (action) {
        case 'change-param':
          changeParamValue(pkey, target.dataset.paramType, target.value);
          break;
        case 'change-array-item':
          changeArrayItem(pkey, parseInt(target.dataset.arrIndex), target.value);
          break;
        case 'change-kv-key':
          changeKvKey(pkey, target.dataset.oldKey, target.value);
          break;
        case 'change-kv-value':
          changeKvValue(pkey, target.dataset.kvKey, target.value);
          break;
      }
    });

    document.getElementById('paramsList').addEventListener('click', (e) => {
      if (e.target.id === 'addParamBtn') {
        addNewParam();
      }
    });

    document.getElementById('paramsList').addEventListener('keydown', (e) => {
      if (e.target.id === 'newParamKey' && e.key === 'Enter') {
        addNewParam();
      }
    });

    document.getElementById('paramsList').addEventListener('click', (e) => {
      if (e.target.id === 'saveBtn') {
        doSave();
      }
    });

    document.getElementById('addConfigBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'addConfig' });
    });

    document.getElementById('addEnvFileBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'addEnvFileToAll' });
    });

    // ===== 接收扩展消息 =====
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'configList':
          configs = msg.configs;
          renderConfigList();
          break;
        case 'configDetail':
          renderParams(msg.params);
          break;
        case 'saved':
          markClean();
          showToast('已保存');
          // 刷新左侧列表以显示最新的参数
          vscode.postMessage({ type: 'ready' });
          break;
        case 'envFileAdded':
          showToast('已为所有启动项添加 envFile');
          vscode.postMessage({ type: 'ready' });
          // 刷新右侧面板（如果已选中配置）
          if (selectedFolderIndex >= 0 && selectedConfigIndex >= 0) {
            vscode.postMessage({
              type: 'selectConfig',
              configIndex: selectedConfigIndex,
              folderIndex: selectedFolderIndex,
            });
          }
          break;
        case 'configDeleted':
          // 如果删除的是当前选中的配置，清空右侧面板
          if (selectedFolderIndex === msg.folderIndex && selectedConfigIndex === msg.configIndex) {
            selectedFolderIndex = -1;
            selectedConfigIndex = -1;
            currentParams = [];
            dirty = false;
            detailHeader.innerHTML = '<span class="config-name">选择左侧配置</span>';
            paramsList.style.display = 'none';
            detailEmpty.style.display = 'flex';
          }
          renderConfigList();
          break;
      }
    });

    // 通知扩展已就绪
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 编辑器面板管理
// ---------------------------------------------------------------------------

export class LaunchConfigEditor {
  private panel: vscode.WebviewPanel | undefined;
  private currentConfigs: LaunchConfigInfo[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.refreshConfigList();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'launchConfigEditor',
      'Launch 配置编辑器',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.iconPath = new vscode.ThemeIcon('gear');
    this.panel.webview.html = getWebviewContent(this.panel.webview, this.context.extensionUri);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions
    );

    this.refreshConfigList();
  }

  private refreshConfigList(): void {
    this.currentConfigs = readAllLaunchConfigs();
    this.postMessage({ type: 'configList', configs: this.currentConfigs });
  }

  private postMessage(msg: ExtensionMessage): void {
    this.panel?.webview.postMessage(msg);
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.refreshConfigList();
        break;

      case 'selectConfig': {
        const cfg = this.currentConfigs.find(
          c => c.folderIndex === msg.folderIndex && c.configIndex === msg.configIndex
        );
        if (cfg) {
          const params = configToParams(cfg.raw);
          this.postMessage({ type: 'configDetail', config: cfg, params });
        }
        break;
      }

      case 'deleteConfig': {
        const cfg = this.currentConfigs.find(
          c => c.folderIndex === msg.folderIndex && c.configIndex === msg.configIndex
        );
        if (!cfg) break;
        // 注意：webview 已弹出 confirm 确认框，此处不再重复确认

        const allCfgs = readAllLaunchConfigs();
        const folderCfgs = allCfgs
          .filter(c => c.folderIndex === msg.folderIndex)
          .map(c => c.raw);

        if (msg.configIndex >= 0 && msg.configIndex < folderCfgs.length) {
          folderCfgs.splice(msg.configIndex, 1);
          try {
            await writeLaunchJson(msg.folderIndex, folderCfgs);
          } catch (err: any) {
            vscode.window.showErrorMessage(`删除失败: ${err.message}`);
            break;
          }

          // 直接更新内存缓存：移除被删项，并修正同文件夹后续项的 configIndex
          this.currentConfigs = this.currentConfigs.filter(
            c => !(c.folderIndex === msg.folderIndex && c.configIndex === msg.configIndex)
          );
          for (const c of this.currentConfigs) {
            if (c.folderIndex === msg.folderIndex && c.configIndex > msg.configIndex) {
              c.configIndex--;
            }
          }

          this.postMessage({ type: 'configList', configs: this.currentConfigs });
          this.postMessage({
            type: 'configDeleted',
            configIndex: msg.configIndex,
            folderIndex: msg.folderIndex,
          });
          vscode.window.showInformationMessage(`已删除配置 "${cfg.name}"`);
        }
        break;
      }

      case 'addConfig': {
        // 扫描项目，自动检测可启动项
        const scanned = await scanProjectForLaunchConfigs();
        if (scanned.length === 0) {
          vscode.window.showWarningMessage('未在项目中检测到可启动的项（Node.js / Python / Java）');
          break;
        }

        const folders = vscode.workspace.workspaceFolders;
        const folderIndex = folders && folders.length > 0 ? 0 : -1;
        const allCfgs = readAllLaunchConfigs();
        const folderCfgs = allCfgs
          .filter(c => c.folderIndex === folderIndex)
          .map(c => c.raw);

        // 过滤掉已存在的同名配置
        const existingNames = new Set(folderCfgs.map((c: any) => c.name));
        const toAdd = scanned.filter(s => !existingNames.has(s.raw.name));
        if (toAdd.length === 0) {
          vscode.window.showInformationMessage(`检测到 ${scanned.length} 个启动项，但已全部存在`);
          break;
        }

        for (const s of toAdd) {
          folderCfgs.push(s.raw);
        }

        try {
          await writeLaunchJson(folderIndex, folderCfgs);
        } catch (err: any) {
          vscode.window.showErrorMessage(`新增失败: ${err.message}`);
          break;
        }

        // 直接更新内存缓存
        for (let i = 0; i < toAdd.length; i++) {
          const s = toAdd[i];
          const newConfigIndex = folderCfgs.length - toAdd.length + i;
          this.currentConfigs.push({
            name: s.name,
            type: s.type,
            request: 'launch',
            raw: { ...s.raw },
            folderIndex,
            configIndex: newConfigIndex,
          });
        }

        this.postMessage({ type: 'configList', configs: this.currentConfigs });
        vscode.window.showInformationMessage(
          `扫描完成，新增 ${toAdd.length} 个启动配置` +
          (scanned.length - toAdd.length > 0 ? `（${scanned.length - toAdd.length} 个已存在）` : '')
        );
        break;
      }

      case 'addEnvFileToAll': {
        const allCfgs = readAllLaunchConfigs();
        const ENV_FILE_VALUE = '${workspaceFolder}/.env';

        // 按 folderIndex 分组，浅拷贝后替换对象（与 saveConfig 一致的方式）
        const groups = new Map<number, any[]>();
        for (const c of allCfgs) {
          const list = groups.get(c.folderIndex) ?? [];
          list.push({ ...c.raw });
          groups.set(c.folderIndex, list);
        }

        let addedCount = 0;
        for (const [fi, cfgs] of groups) {
          let changed = false;
          for (let i = 0; i < cfgs.length; i++) {
            if (cfgs[i].envFile === undefined) {
              cfgs[i] = { ...cfgs[i], envFile: ENV_FILE_VALUE };
              addedCount++;
              changed = true;
            }
          }
          if (changed) {
            try {
              await writeLaunchJson(fi, cfgs);
            } catch (err: any) {
              vscode.window.showErrorMessage(`添加 envFile 失败: ${err.message}`);
              break;
            }
            // 直接更新内存缓存，避免 getConfiguration 尚未刷新导致读到旧数据
            for (let i = 0; i < cfgs.length; i++) {
              const cached = this.currentConfigs.find(
                cc => cc.folderIndex === fi && cc.configIndex === i
              );
              if (cached) {
                cached.raw = { ...cfgs[i] };
                cached.name = cfgs[i].name ?? cached.name;
                cached.type = cfgs[i].type ?? cached.type;
                cached.request = cfgs[i].request ?? cached.request;
              }
            }
          }
        }

        this.postMessage({ type: 'configList', configs: this.currentConfigs });
        this.postMessage({ type: 'envFileAdded' });
        vscode.window.showInformationMessage(`已为 ${addedCount} 个启动项添加 envFile`);
        break;
      }

      case 'saveConfig': {
        const allCfgs = readAllLaunchConfigs();
        const folderCfgs = allCfgs
          .filter(c => c.folderIndex === msg.folderIndex)
          .map(c => c.raw);

        if (msg.configIndex >= 0 && msg.configIndex < folderCfgs.length) {
          // 保留内置字段（name, type, request），其余用 webview 传来的 raw 覆盖
          folderCfgs[msg.configIndex] = {
            name: folderCfgs[msg.configIndex].name,
            type: folderCfgs[msg.configIndex].type,
            request: folderCfgs[msg.configIndex].request,
            ...msg.raw,
          };
          try {
            await writeLaunchJson(msg.folderIndex, folderCfgs);
          } catch (err: any) {
            vscode.window.showErrorMessage(`保存失败: ${err.message}`);
            break;
          }
          // 直接更新内存缓存，避免 getConfiguration 尚未刷新导致读到旧数据
          const cached = this.currentConfigs.find(
            c => c.folderIndex === msg.folderIndex && c.configIndex === msg.configIndex
          );
          if (cached) {
            cached.raw = folderCfgs[msg.configIndex];
          }
          this.postMessage({ type: 'configList', configs: this.currentConfigs });
          this.postMessage({
            type: 'saved',
            configIndex: msg.configIndex,
            folderIndex: msg.folderIndex,
          });
        }
        break;
      }
    }
  }
}