// ---------------------------------------------------------------------------
// Launch 配置编辑器 webview 的 HTML / CSS / 前端脚本。
// 所有面向用户的文案来自 l10n.webviewMessages()，经 I18N 注入前端由 T(key) 取用，
// 本文件不出现任何硬编码文案。
// ---------------------------------------------------------------------------

/** 前端脚本按 name 落到元素上（避免重复的 getElementById 字符串） */
const CONFIG_LIST_ID = 'configList';
const PARAMS_LIST_ID = 'paramsList';

export function getWebviewContent(t: Record<string, string>): string {
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.editorTitle}</title>
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
      width: 50%;
      min-width: 300px;
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

    /* loading 状态 */
    .loading-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    button.loading { pointer-events: none; opacity: 0.6; }
    .global-loading {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: transparent;
      z-index: 200;
      cursor: wait;
    }
  </style>
</head>
<body>
  <div class="app">
    <!-- 左侧配置列表 -->
    <div class="sidebar">
      <div class="sidebar-header">
        <span>${t.sidebarTitle}</span>
        <button class="add-btn" id="addConfigBtn" title="${t.btnScanAddTitle}" style="margin-right:4px;">${t.btnScanAdd}</button>
        <button class="add-btn" id="addEnvVarsBtn" title="${t.btnAddEnvVarsTitle}">${t.btnAddEnvVars}</button>
      </div>
      <div class="config-list" id="${CONFIG_LIST_ID}">
        <div class="empty-list">${t.loading}</div>
      </div>
    </div>

    <!-- 右侧参数详情 -->
    <div class="detail">
      <div class="detail-header" id="detailHeader">
        <span class="config-name">${t.selectHint}</span>
      </div>
      <div class="detail-empty" id="detailEmpty">
        ${t.detailEmpty}
      </div>
      <div class="params-list" id="${PARAMS_LIST_ID}" style="display:none;"></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const vscode = acquireVsCodeApi();

    // ===== i18n（由扩展注入，禁止在下方硬编码文案） =====
    const I18N = ${JSON.stringify(t)};
    function T(key, ...args) {
      const s = I18N[key] !== undefined ? I18N[key] : key;
      return s.replace(/\\{(\\d+)\\}/g, (m, i) => (args[+i] !== undefined ? String(args[+i]) : ''));
    }

    // ===== 状态 =====
    let configs = [];
    let selectedFolderIndex = -1;
    let selectedConfigIndex = -1;
    let currentParams = [];     // 当前显示的参数（来自文件或上次保存）
    let dirty = false;          // 是否有未保存的修改
    let expandedConfigs = {};   // 左侧展开状态：key = folderIndex:configIndex
    let loadingAction = null;   // 当前正在进行的操作：'delete' | 'save' | 'addConfig' | 'addEnvVars' | null

    // ===== Loading 控制 =====
    function startLoading(action, btnEl) {
      loadingAction = action;
      if (btnEl) {
        btnEl.classList.add('loading');
        const orig = btnEl.innerHTML;
        btnEl.dataset.origHtml = orig;
        btnEl.innerHTML = '<span class="loading-spinner"></span>';
      }
      // 全局遮罩，阻止重复点击
      let overlay = document.getElementById('globalLoadingOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'globalLoadingOverlay';
        overlay.className = 'global-loading';
        document.body.appendChild(overlay);
      }
    }

    function endLoading() {
      loadingAction = null;
      // 恢复所有 loading 按钮
      document.querySelectorAll('button.loading').forEach(btn => {
        btn.classList.remove('loading');
        if (btn.dataset.origHtml) {
          btn.innerHTML = btn.dataset.origHtml;
          delete btn.dataset.origHtml;
        }
      });
      const overlay = document.getElementById('globalLoadingOverlay');
      if (overlay) overlay.remove();
    }

    // ===== DOM 引用 =====
    const $ = (id) => document.getElementById(id);
    const configList = $('${CONFIG_LIST_ID}');
    const detailHeader = $('detailHeader');
    const detailEmpty = $('detailEmpty');
    const paramsList = $('${PARAMS_LIST_ID}');
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
        configList.innerHTML = '<div class="empty-list">' + escHtml(T('emptyList')) + '</div>';
        return;
      }

      const getExpKey = (fi, ci) => fi + ':' + ci;

      let html = '';
      for (const cfg of configs) {
        const isSel = cfg.folderIndex === selectedFolderIndex && cfg.configIndex === selectedConfigIndex;
        const expKey = getExpKey(cfg.folderIndex, cfg.configIndex);
        const isExpanded = !!expandedConfigs[expKey];
        // 参数由扩展侧统一计算（单一实现），此处只做展示过滤
        const extraParams = (cfg.params || []).filter(p => !p.builtin);

        html += '<div class="config-item' + (isSel ? ' selected' : '') + '"'
          + ' data-folder="' + cfg.folderIndex + '"'
          + ' data-index="' + cfg.configIndex + '"'
          + ' data-action="select">'
          + '<span class="expand-icon' + (isExpanded ? ' expanded' : '') + '" data-action="toggle-expand">' + (extraParams.length > 0 ? '▶' : '') + '</span>'
          + '<span class="name" title="' + escHtml(cfg.name) + '">' + escHtml(cfg.name) + '</span>'
          + '<span class="type-badge">' + escHtml(cfg.type) + '</span>'
          + '<span class="item-actions">'
          + '<button data-action="delete-config" title="' + escHtml(T('deleteTitle')) + '">✕</button>'
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
        html += '<div class="param-group"><div class="param-group-title">' + escHtml(T('groupBasic')) + '</div>';
        html += builtinParams.map(p => renderParamRow(p, true)).join('');
        html += '</div>';
      }

      html += '<div class="param-group"><div class="param-group-title">' + escHtml(T('groupExtra')) + '</div>';
      if (extraParams.length === 0) {
        html += '<div style="color:var(--vscode-descriptionForeground);font-size:12px;padding:8px;">' + escHtml(T('noExtraParams')) + '</div>';
      } else {
        html += extraParams.map(p => renderParamRow(p, false)).join('');
      }
      html += renderAddParamSection(currentParams.map(p => p.key));
      html += '</div>';

      // 保存按钮放在添加参数下面
      html += '<div style="margin-top:16px;">'
        + '<button class="save-btn" id="saveBtn">' + escHtml(T('save')) + '</button>'
        + '</div>';

      paramsList.innerHTML = html;
    }

    function renderParamRow(param, isBuiltin) {
      const keyClass = isBuiltin ? 'param-key builtin' : 'param-key';
      const deleteDisabled = isBuiltin ? ' disabled' : '';
      const deleteTitle = isBuiltin ? T('builtinUndeletable') : T('deleteParamTitle');

      return '<div class="param-row" data-param-key="' + escHtml(param.key) + '">'
        + '<span class="' + keyClass + '" title="' + escHtml(param.key) + '">' + escHtml(param.key) + '</span>'
        + '<div class="param-value-area">'
        + renderValueEditor(param)
        + '</div>'
        + '<div class="param-actions">'
        + '<button data-action="delete-param" data-param-key="' + escHtml(param.key) + '"' + deleteDisabled + ' title="' + escHtml(deleteTitle) + '">✕</button>'
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
        return '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">' + escHtml(T('emptyArray')) + '</div>'
          + '<div class="mini-btn-row"><button data-action="add-array-item" data-param-key="' + escHtml(key) + '">' + escHtml(T('addItem')) + '</button></div>';
      }
      let html = '';
      for (let i = 0; i < arr.length; i++) {
        html += '<div class="array-item">'
          + '<input type="text" value="' + escHtml(String(arr[i])) + '" data-action="change-array-item" data-param-key="' + escHtml(key) + '" data-arr-index="' + i + '" />'
          + '<button class="arr-remove" data-action="remove-array-item" data-param-key="' + escHtml(key) + '" data-arr-index="' + i + '">✕</button>'
          + '</div>';
      }
      html += '<div class="mini-btn-row"><button data-action="add-array-item" data-param-key="' + escHtml(key) + '">' + escHtml(T('addItem')) + '</button></div>';
      return html;
    }

    function renderObjectEditor(key, obj) {
      if (typeof obj !== 'object' || obj === null) {
        return '<input type="text" value="' + escHtml(JSON.stringify(obj)) + '" data-action="change-param" data-param-key="' + escHtml(key) + '" data-param-type="string" />';
      }
      const entries = Object.entries(obj);
      if (entries.length === 0) {
        return '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">' + escHtml(T('emptyObject')) + '</div>'
          + '<div class="mini-btn-row"><button data-action="add-kv-pair" data-param-key="' + escHtml(key) + '">' + escHtml(T('addKvPair')) + '</button></div>';
      }
      let html = '';
      for (const [k, v] of entries) {
        html += '<div class="kv-pair" data-param-key="' + escHtml(key) + '" data-kv-key="' + escHtml(k) + '">'
          + '<input type="text" value="' + escHtml(k) + '" placeholder="' + escHtml(T('keyPlaceholder')) + '" data-action="change-kv-key" data-param-key="' + escHtml(key) + '" data-old-key="' + escHtml(k) + '" />'
          + '<span class="kv-sep">:</span>'
          + '<input type="text" value="' + escHtml(String(v)) + '" placeholder="' + escHtml(T('valuePlaceholder')) + '" data-action="change-kv-value" data-param-key="' + escHtml(key) + '" data-kv-key="' + escHtml(k) + '" />'
          + '<button class="kv-remove" data-action="remove-kv-pair" data-param-key="' + escHtml(key) + '" data-kv-key="' + escHtml(k) + '">✕</button>'
          + '</div>';
      }
      html += '<div class="mini-btn-row"><button data-action="add-kv-pair" data-param-key="' + escHtml(key) + '">' + escHtml(T('addKvPair')) + '</button></div>';
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
        options = '<option value="" disabled>' + escHtml(T('allParamsAdded')) + '</option>';
      } else {
        options = available.map(k => '<option value="' + k + '">' + k + '</option>').join('');
      }
      return '<div class="add-param-section">'
        + '<select id="newParamKey" style="flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:5px 8px;border-radius:3px;font-size:12px;font-family:inherit;">'
        + options
        + '</select>'
        + '<button id="addParamBtn">' + escHtml(T('addParam')) + '</button>'
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
        btn.textContent = T('saveDirty');
        btn.className = 'save-btn dirty';
      }
    }

    function markClean() {
      dirty = false;
      const btn = $('saveBtn');
      if (btn) {
        btn.textContent = T('save');
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
        showToast(T('builtinUndeletable'), true);
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
        showToast(T('selectParamName'), true);
        return;
      }
      if (currentParams.some(p => p.key === key)) {
        showToast(T('paramExists', key), true);
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
      showToast(T('paramAdded', key));
    }

    // ===== 保存 =====
    function doSave() {
      if (loadingAction) return;
      const raw = {};
      for (const p of currentParams) {
        raw[p.key] = p.value;
      }
      startLoading('save', $('saveBtn'));
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
    configList.addEventListener('click', (e) => {
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
          if (loadingAction) return;
          startLoading('delete', target);
          vscode.postMessage({ type: 'deleteConfig', configIndex: index, folderIndex: folder });
          break;
      }
    });

    paramsList.addEventListener('click', (e) => {
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

    paramsList.addEventListener('change', (e) => {
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

    paramsList.addEventListener('click', (e) => {
      if (e.target.id === 'addParamBtn') {
        addNewParam();
      }
    });

    paramsList.addEventListener('keydown', (e) => {
      if (e.target.id === 'newParamKey' && e.key === 'Enter') {
        addNewParam();
      }
    });

    paramsList.addEventListener('click', (e) => {
      if (e.target.id === 'saveBtn') {
        doSave();
      }
    });

    $('addConfigBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'addConfig' });
    });

    $('addEnvVarsBtn').addEventListener('click', () => {
      if (loadingAction) return;
      startLoading('addEnvVars', $('addEnvVarsBtn'));
      vscode.postMessage({ type: 'addEnvVars' });
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
          endLoading();
          markClean();
          showToast(T('savedToast'));
          // configList 消息已包含最新数据，无需再发 ready 触发可能读到旧数据的 refreshConfigList
          break;
        case 'envVarsAdded':
          endLoading();
          showToast(T('envVarsAddedToast'));
          // configList 消息已包含最新数据，无需再发 ready
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
          endLoading();
          // 如果删除的是当前选中的配置，清空右侧面板
          if (selectedFolderIndex === msg.folderIndex && selectedConfigIndex === msg.configIndex) {
            selectedFolderIndex = -1;
            selectedConfigIndex = -1;
            currentParams = [];
            dirty = false;
            detailHeader.innerHTML = '<span class="config-name">' + escHtml(T('selectHint')) + '</span>';
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
