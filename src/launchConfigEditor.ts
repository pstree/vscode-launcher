// ---------------------------------------------------------------------------
// Launch 配置编辑器面板：webview 生命周期 + 消息协议分发。
// launch.json 读写见 launchConfigStore，项目扫描见 projectScanner，
// 页面内容见 webviewHtml。
// ---------------------------------------------------------------------------
import * as vscode from 'vscode';
import { l10n, webviewMessages } from './l10n';
import {
  ConfigRef,
  EditableParam,
  LaunchConfigInfo,
  NO_FOLDER,
  configToParams,
  readAllLaunchConfigs,
  readRawConfigsOfFolder,
  sameRef,
  writeLaunchJson,
} from './launchConfigStore';
import { scanProjectForLaunchConfigs } from './projectScanner';
import { ensureEnvFiles } from './envFile';
import { getWebviewContent } from './webviewHtml';

// ---------------------------------------------------------------------------
// Webview 消息协议
// ---------------------------------------------------------------------------

/** 配置列表项：携带扩展侧算好的参数，避免 webview 重复实现类型推导 */
interface ConfigListItem extends LaunchConfigInfo {
  params: EditableParam[];
}

type WebviewMessage =
  | { type: 'ready' }
  | ({ type: 'selectConfig' } & ConfigRef)
  | ({ type: 'deleteConfig' } & ConfigRef)
  | { type: 'addConfig' }
  | ({ type: 'saveConfig'; raw: Record<string, any> } & ConfigRef)
  | { type: 'addEnvVars' };

type ExtensionMessage =
  | { type: 'configList'; configs: ConfigListItem[] }
  | { type: 'configDetail'; config: LaunchConfigInfo; params: EditableParam[] }
  | ({ type: 'saved' } & ConfigRef)
  | { type: 'envVarsAdded' }
  | ({ type: 'configDeleted' } & ConfigRef);

/** 写入各 launch 配置的 envFile 路径；与 .env 实际落盘位置一致 */
const ENV_FILE_VALUE = '${workspaceFolder}/.env';

// ---------------------------------------------------------------------------
// 面板
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

    const t = webviewMessages();
    this.panel = vscode.window.createWebviewPanel(
      'launchConfigEditor',
      t.editorTitle,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.iconPath = new vscode.ThemeIcon('gear');
    this.panel.webview.html = getWebviewContent(t);

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

  private findConfig(ref: ConfigRef): LaunchConfigInfo | undefined {
    return this.currentConfigs.find((c) => sameRef(c, ref));
  }

  private refreshConfigList(): void {
    this.currentConfigs = readAllLaunchConfigs();
    this.postConfigList();
  }

  private postConfigList(): void {
    this.postMessage({
      type: 'configList',
      configs: this.currentConfigs.map((c) => ({ ...c, params: configToParams(c.raw) })),
    });
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
        const cfg = this.findConfig(msg);
        if (cfg) {
          this.postMessage({ type: 'configDetail', config: cfg, params: configToParams(cfg.raw) });
        }
        break;
      }

      case 'deleteConfig': {
        const cfg = this.findConfig(msg);
        if (!cfg) {
          break;
        }
        const folderCfgs = readRawConfigsOfFolder(msg.folderIndex);
        if (msg.configIndex < 0 || msg.configIndex >= folderCfgs.length) {
          break;
        }

        folderCfgs.splice(msg.configIndex, 1);
        try {
          await writeLaunchJson(msg.folderIndex, folderCfgs);
        } catch (err: any) {
          vscode.window.showErrorMessage(l10n('deleteFailed', err.message));
          break;
        }

        // 直接更新内存缓存：移除被删项，并修正同文件夹后续项的 configIndex
        this.currentConfigs = this.currentConfigs.filter((c) => !sameRef(c, msg));
        for (const c of this.currentConfigs) {
          if (c.folderIndex === msg.folderIndex && c.configIndex > msg.configIndex) {
            c.configIndex--;
          }
        }

        this.postConfigList();
        this.postMessage({
          type: 'configDeleted',
          folderIndex: msg.folderIndex,
          configIndex: msg.configIndex,
        });
        vscode.window.showInformationMessage(l10n('deletedConfig', cfg.name));
        break;
      }

      case 'addConfig': {
        // 扫描项目，自动检测可启动项
        const scanned = await scanProjectForLaunchConfigs();
        if (scanned.length === 0) {
          vscode.window.showWarningMessage(l10n('noLaunchable'));
          break;
        }

        const folders = vscode.workspace.workspaceFolders;
        const folderIndex = folders && folders.length > 0 ? 0 : NO_FOLDER;
        const folderCfgs = readRawConfigsOfFolder(folderIndex);

        // 过滤掉已存在的同名配置
        const existingNames = new Set(folderCfgs.map((c: any) => c.name));
        const toAdd = scanned.filter((s) => !existingNames.has(s.raw.name));
        if (toAdd.length === 0) {
          vscode.window.showInformationMessage(l10n('allConfigsExist', scanned.length));
          break;
        }

        for (const s of toAdd) {
          folderCfgs.push(s.raw);
        }

        try {
          await writeLaunchJson(folderIndex, folderCfgs);
        } catch (err: any) {
          vscode.window.showErrorMessage(l10n('addFailed', err.message));
          break;
        }

        // 直接更新内存缓存（新配置追加在末尾）
        const firstNewIndex = folderCfgs.length - toAdd.length;
        toAdd.forEach((s, i) => {
          this.currentConfigs.push({
            name: s.name,
            type: s.type,
            request: 'launch',
            raw: { ...s.raw },
            folderIndex,
            configIndex: firstNewIndex + i,
          });
        });

        const alreadyExisting = scanned.length - toAdd.length;
        this.postConfigList();
        vscode.window.showInformationMessage(
          alreadyExisting > 0
            ? l10n('scanDoneWithExisting', toAdd.length, alreadyExisting)
            : l10n('scanDone', toAdd.length)
        );
        break;
      }

      case 'addEnvVars': {
        // 1) 为所有缺 envFile 的配置补齐 envFile（按 folderIndex 分组，浅拷贝后替换对象）
        const groups = new Map<number, any[]>();
        for (const c of readAllLaunchConfigs()) {
          const list = groups.get(c.folderIndex) ?? [];
          list.push({ ...c.raw });
          groups.set(c.folderIndex, list);
        }

        let addedCount = 0;
        for (const [folderIndex, cfgs] of groups) {
          let changed = false;
          for (let i = 0; i < cfgs.length; i++) {
            if (cfgs[i].envFile === undefined) {
              cfgs[i] = { ...cfgs[i], envFile: ENV_FILE_VALUE };
              addedCount++;
              changed = true;
            }
          }
          if (!changed) {
            continue;
          }
          try {
            await writeLaunchJson(folderIndex, cfgs);
          } catch (err: any) {
            vscode.window.showErrorMessage(l10n('envFileAddFailed', err.message));
            break;
          }
          // 直接更新内存缓存，避免 getConfiguration 尚未刷新导致读到旧数据
          this.syncCachedRaw(folderIndex, cfgs);
        }

        // 2) 创建 / 补齐各 folder 根目录的 .env（即 envFile 指向的路径），
        //    写入默认环境变量；已存在的键一律不覆盖。
        let envFilesWritten = 0;
        try {
          envFilesWritten = await ensureEnvFiles();
        } catch (err: any) {
          vscode.window.showErrorMessage(l10n('dotEnvWriteFailed', err.message));
        }

        this.postConfigList();
        this.postMessage({ type: 'envVarsAdded' });
        vscode.window.showInformationMessage(l10n('envVarsAdded', addedCount, envFilesWritten));
        break;
      }

      case 'saveConfig': {
        const folderCfgs = readRawConfigsOfFolder(msg.folderIndex);
        if (msg.configIndex < 0 || msg.configIndex >= folderCfgs.length) {
          break;
        }

        // 保留内置字段（name, type, request），其余用 webview 传来的 raw 覆盖
        const original = folderCfgs[msg.configIndex];
        const saved: Record<string, any> = {
          name: original.name,
          type: original.type,
          request: original.request,
          ...msg.raw,
        };
        folderCfgs[msg.configIndex] = saved;

        try {
          await writeLaunchJson(msg.folderIndex, folderCfgs);
        } catch (err: any) {
          vscode.window.showErrorMessage(l10n('saveFailed', err.message));
          break;
        }

        // 直接更新内存缓存，避免 getConfiguration 尚未刷新导致读到旧数据
        const cached = this.findConfig(msg);
        if (cached) {
          cached.raw = saved;
        }
        this.postConfigList();
        this.postMessage({ type: 'saved', folderIndex: msg.folderIndex, configIndex: msg.configIndex });
        break;
      }
    }
  }

  /** 把某个 folder 写盘后的配置回填到内存缓存（避免读到 getConfiguration 的旧值） */
  private syncCachedRaw(folderIndex: number, cfgs: any[]): void {
    cfgs.forEach((raw, i) => {
      const cached = this.currentConfigs.find(
        (c) => c.folderIndex === folderIndex && c.configIndex === i
      );
      if (cached) {
        cached.raw = { ...raw };
        cached.name = raw.name ?? cached.name;
        cached.type = raw.type ?? cached.type;
        cached.request = raw.request ?? cached.request;
      }
    });
  }
}
