// ---------------------------------------------------------------------------
// 简易 i18n：跟随 VS Code 语言切换，支持简体中文 / English。
// 采用纯 TS 消息映射，动态读取 vscode.env.language，无需 bundle 构建步骤。
// ---------------------------------------------------------------------------
import * as vscode from 'vscode';

type Messages = { [key: string]: string };

const zhCN: Messages = {
  runningCount: '运行中 ({0})',
  idleCount: '未运行 ({0})',
  focusTerminal: '查看终端',
  notLinkedTerminal: '「{0}」未关联集成终端（当前 console="{1}"）。',
  howToLinkTerminal:
    '如需在终端查看启动日志，请在其 launch 配置中加入 "console": "integratedTerminal"，然后重新启动。',
  allRunning: '勾选的配置均已运行，无需重复启动。',
  nothingRunning: '当前没有正在运行的程序。',
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
};

function currentMessages(): Messages {
  const lang = vscode.env.language.toLowerCase();
  // 简体中文（含 zh-cn / zh-hans 等）使用中文，其余（含 zh-tw/zh-hant）使用英文
  if (lang.startsWith('zh') && !lang.includes('tw') && !lang.includes('hant')) {
    return zhCN;
  }
  return en;
}

/** 格式化字符串：{0} {1} ... 依次替换 */
function format(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (_, idx) => {
    const i = parseInt(idx, 10);
    return i < args.length ? String(args[i]) : '';
  });
}

export function l10n(key: string, ...args: (string | number)[]): string {
  const msg = currentMessages()[key];
  if (msg === undefined) {
    return key;
  }
  return format(msg, ...args);
}
