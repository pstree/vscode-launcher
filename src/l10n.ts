// ---------------------------------------------------------------------------
// 简易 i18n：跟随 VS Code 语言切换，支持简体中文 / English。
// 采用纯 TS 消息映射，动态读取 vscode.env.language，无需 bundle 构建步骤。
//
//   - l10n(key, ...)       扩展宿主侧文案（通知、树节点标题等）
//   - webviewMessages()    webview 侧文案表，注入 HTML 后由前端 T(key) 取用
//
// 约定：所有面向用户的字符串都必须走本模块，禁止在其它文件硬编码文案。
// ---------------------------------------------------------------------------
import * as vscode from 'vscode';

type Messages = { [key: string]: string };

// ---------------------------------------------------------------------------
// 扩展宿主侧
// ---------------------------------------------------------------------------

const zhCN: Messages = {
  runningCount: '运行中 ({0})',
  idleCount: '未运行 ({0})',
  focusTerminal: '查看终端',
  notLinkedTerminal: '「{0}」未关联集成终端（当前 console="{1}"）。',
  howToLinkTerminal:
    '如需在终端查看启动日志，请在其 launch 配置中加入 "console": "integratedTerminal"，然后重新启动。',
  allRunning: '勾选的配置均已运行，无需重复启动。',
  nothingRunning: '当前没有正在运行的程序。',
  saved: '已保存',
  deletedConfig: '已删除配置 "{0}"',
  deleteFailed: '删除失败: {0}',
  saveFailed: '保存失败: {0}',
  addFailed: '新增失败: {0}',
  envFileAddFailed: '添加 envFile 失败: {0}',
  dotEnvWriteFailed: '写入 .env 失败: {0}',
  noLaunchable: '未在项目中检测到可启动的项（Node.js / Python / Java）',
  allConfigsExist: '检测到 {0} 个启动项，但已全部存在',
  scanDone: '扫描完成，新增 {0} 个启动配置',
  scanDoneWithExisting: '扫描完成，新增 {0} 个启动配置（{1} 个已存在）',
  envVarsAdded: '已为 {0} 个启动项添加 envFile，并写入 {1} 个 .env 文件',
};

const en: Messages = {
  runningCount: 'Running ({0})',
  idleCount: 'Not running ({0})',
  focusTerminal: 'View terminal',
  notLinkedTerminal: '"{0}" is not linked to an integrated terminal (console="{1}").',
  howToLinkTerminal:
    'To view startup logs in a terminal, add "console": "integratedTerminal" to its launch configuration, then restart it.',
  allRunning: 'All selected configurations are already running, nothing to launch.',
  nothingRunning: 'No programs are currently running.',
  saved: 'Saved',
  deletedConfig: 'Deleted configuration "{0}"',
  deleteFailed: 'Delete failed: {0}',
  saveFailed: 'Save failed: {0}',
  addFailed: 'Add failed: {0}',
  envFileAddFailed: 'Adding envFile failed: {0}',
  dotEnvWriteFailed: 'Writing .env failed: {0}',
  noLaunchable: 'No launchable item (Node.js / Python / Java) was detected in the project.',
  allConfigsExist: 'Detected {0} launch items, but all of them already exist.',
  scanDone: 'Scan finished, {0} launch configurations added',
  scanDoneWithExisting: 'Scan finished, {0} launch configurations added ({1} already existed)',
  envVarsAdded: 'envFile added to {0} launch items; {1} .env file(s) written',
};

// ---------------------------------------------------------------------------
// Webview 侧（键名与 webviewHtml.ts / 前端脚本一一对应）
// ---------------------------------------------------------------------------

const webviewZhCN: Messages = {
  htmlLang: 'zh-CN',
  editorTitle: 'Launch 配置编辑器',
  sidebarTitle: '启动配置',
  btnScanAdd: '一键新增',
  btnScanAddTitle: '扫描项目并自动添加启动配置',
  btnAddEnvVars: '添加环境变量',
  btnAddEnvVarsTitle: '为所有启动项添加 envFile，并创建 .env 写入默认环境变量',
  loading: '加载中...',
  selectHint: '选择左侧配置',
  detailEmpty: '请从左侧列表选择一个启动配置来编辑其参数',
  emptyList: '暂无启动配置',
  deleteTitle: '删除',
  groupBasic: '基本属性',
  groupExtra: '其他参数',
  noExtraParams: '暂无额外参数',
  builtinUndeletable: '内置字段不可删除',
  deleteParamTitle: '删除此参数',
  save: '保存',
  saveDirty: '保存 *',
  emptyArray: '空数组',
  addItem: '+ 添加',
  emptyObject: '空对象',
  addKvPair: '+ 添加键值',
  keyPlaceholder: '键',
  valuePlaceholder: '值',
  allParamsAdded: '所有常用参数已添加',
  addParam: '添加参数',
  selectParamName: '请选择参数名',
  paramExists: '参数 "{0}" 已存在',
  paramAdded: '已添加参数 "{0}"（点击保存生效）',
  savedToast: '已保存',
  envVarsAddedToast: '已添加环境变量',
};

const webviewEn: Messages = {
  htmlLang: 'en',
  editorTitle: 'Launch Config Editor',
  sidebarTitle: 'Launch Configurations',
  btnScanAdd: 'Scan & Add',
  btnScanAddTitle: 'Scan the project and add launch configurations automatically',
  btnAddEnvVars: 'Add Env Variables',
  btnAddEnvVarsTitle: 'Add envFile to all launch items and create .env with default variables',
  loading: 'Loading...',
  selectHint: 'Select a configuration',
  detailEmpty: 'Select a launch configuration from the list to edit its parameters',
  emptyList: 'No launch configurations',
  deleteTitle: 'Delete',
  groupBasic: 'Basic',
  groupExtra: 'Other Parameters',
  noExtraParams: 'No extra parameters',
  builtinUndeletable: 'Built-in fields cannot be deleted',
  deleteParamTitle: 'Delete this parameter',
  save: 'Save',
  saveDirty: 'Save *',
  emptyArray: 'Empty array',
  addItem: '+ Add',
  emptyObject: 'Empty object',
  addKvPair: '+ Add key/value',
  keyPlaceholder: 'key',
  valuePlaceholder: 'value',
  allParamsAdded: 'All common parameters have been added',
  addParam: 'Add Parameter',
  selectParamName: 'Please select a parameter name',
  paramExists: 'Parameter "{0}" already exists',
  paramAdded: 'Parameter "{0}" added (click Save to apply)',
  savedToast: 'Saved',
  envVarsAddedToast: 'Environment variables added',
};

function isSimplifiedChinese(): boolean {
  const lang = vscode.env.language.toLowerCase();
  // 简体中文（含 zh-cn / zh-hans 等）使用中文，其余（含 zh-tw/zh-hant）使用英文
  return lang.startsWith('zh') && !lang.includes('tw') && !lang.includes('hant');
}

/** 格式化字符串：{0} {1} ... 依次替换 */
function format(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (_, idx) => {
    const i = parseInt(idx, 10);
    return i < args.length ? String(args[i]) : '';
  });
}

function pick(dict: Messages, key: string, ...args: (string | number)[]): string {
  const msg = dict[key];
  return msg === undefined ? key : format(msg, ...args);
}

export function l10n(key: string, ...args: (string | number)[]): string {
  return pick(isSimplifiedChinese() ? zhCN : en, key, ...args);
}

/** webview 侧文案表（键名 → 文案），由 webviewHtml 注入 HTML */
export function webviewMessages(): Messages {
  return { ...(isSimplifiedChinese() ? webviewZhCN : webviewEn) };
}
