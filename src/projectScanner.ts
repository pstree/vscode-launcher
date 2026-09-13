// ---------------------------------------------------------------------------
// 项目扫描：递归遍历工作区，自动检测 Node / Python / Java 可启动项。
// 纯扫描逻辑，不涉及 UI 与消息协议。
// ---------------------------------------------------------------------------
import * as vscode from 'vscode';

export interface ScannedConfig {
  name: string;
  type: string;
  raw: Record<string, any>;
}

/** Node 项目（package.json）最多扫描层数，前端项目 package.json 通常在项目根附近 */
const NODE_MAX_DEPTH = 3;
/** 遍历目录的总深度上限：Java/Python 的 src/main/java 结构很深，需足够深才能扫到启动类 */
const MAX_DEPTH = 10;
/** 常见依赖 / 构建 / 版本控制目录，不进入扫描 */
const IGNORED_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', 'target', 'build',
  'dist', '.git', '.svn', '.idea', '.vscode', 'out', 'bower_components',
]);
const ENTRY_NAMES = ['main.py', 'app.py', 'run.py', 'server.py', 'manage.py', 'start.py'];

/** 扫描工作区（含子目录），检测可启动项并生成 launch 配置 */
export async function scanProjectForLaunchConfigs(): Promise<ScannedConfig[]> {
  const results: ScannedConfig[] = [];
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return results;
  }

  /** 递归遍历目录（最多 MAX_DEPTH 层），对每个目录调用 scanDir */
  async function walkDir(dirUri: vscode.Uri, relDir: string, depth: number): Promise<void> {
    await scanDir(dirUri, relDir, depth);
    if (depth >= MAX_DEPTH) {
      return;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return;
    }
    for (const [entryName, fileType] of entries) {
      if (fileType !== vscode.FileType.Directory) {
        continue;
      }
      if (IGNORED_DIRS.has(entryName)) {
        continue;
      }
      const childRel = relDir ? `${relDir}/${entryName}` : entryName;
      await walkDir(vscode.Uri.joinPath(dirUri, entryName), childRel, depth + 1);
    }
  }

  /** 扫描单个目录，检测 Node / Python / Java 可启动项 */
  async function scanDir(dirUri: vscode.Uri, relDir: string, depth: number): Promise<void> {
    const projectDir = relDir ? `\${workspaceFolder}/${relDir}` : '${workspaceFolder}';
    // 子目录标识（用于区分不同子项目中同名脚本的配置）
    const label = relDir ? `[${relDir.split('/').pop()}] ` : '';

    // 1. Node.js: 读取 package.json（仅在浅层，避免深层误读）
    if (depth <= NODE_MAX_DEPTH) {
      try {
        const pkgUri = vscode.Uri.joinPath(dirUri, 'package.json');
        const pkgData = await vscode.workspace.fs.readFile(pkgUri);
        const pkg = JSON.parse(Buffer.from(pkgData).toString('utf-8'));

        if (pkg.main) {
          results.push({
            name: `${label}Node: ${pkg.name || 'app'}`,
            type: 'node',
            raw: {
              type: 'node',
              request: 'launch',
              name: `${label}Node: ${pkg.name || 'app'}`,
              program: `${projectDir}/${pkg.main}`,
              skipFiles: ['<node_internals>/**'],
            },
          });
        }

        if (pkg.scripts) {
          for (const [scriptName] of Object.entries(pkg.scripts)) {
            // 识别常见启动脚本：start / serve，或以 dev 结尾（如 dev、ztljdev、lgydev、hhwldev）
            if (scriptName === 'start' || scriptName === 'serve' || scriptName.endsWith('dev')) {
              results.push({
                name: `${label}npm: ${scriptName}`,
                type: 'node-terminal',
                raw: {
                  type: 'node-terminal',
                  request: 'launch',
                  name: `${label}npm: ${scriptName}`,
                  // 在集成终端执行，自动继承 shell（nvm）环境，无需额外配置 npm/node 路径
                  command: `nvm use && npm run ${scriptName}`,
                  cwd: projectDir,
                },
              });
            }
          }
        }
      } catch {
        // 无 package.json，跳过
      }
    }

    // 2 / 3. Python / Java: 扫描当前目录下的文件
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return;
    }

    // Python 入口文件
    for (const [fname, fileType] of entries) {
      if (fileType !== vscode.FileType.File || !fname.endsWith('.py')) {
        continue;
      }
      if (!ENTRY_NAMES.includes(fname)) {
        continue;
      }
      const rel = relDir ? `${relDir}/${fname}` : fname;
      const displayName = `${label}Python: ${fname}`;
      results.push({
        name: displayName,
        type: 'python',
        raw: {
          type: 'python',
          request: 'launch',
          name: displayName,
          program: `\${workspaceFolder}/${rel}`,
          console: 'integratedTerminal',
        },
      });
    }

    // Java 启动类：类名以 Application 结尾（Maven 微服务入口），且含 main 方法或 @SpringBootApplication
    for (const [fname, fileType] of entries) {
      if (fileType !== vscode.FileType.File || !fname.endsWith('.java')) {
        continue;
      }
      // 仅关注应用启动类，过滤掉 Utils/Test 等工具类噪音
      if (!/Application\.java$/.test(fname)) {
        continue;
      }
      try {
        const content = Buffer.from(
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, fname))
        ).toString('utf-8');
        const isApp =
          /@SpringBootApplication/.test(content) ||
          /SpringApplication\.run/.test(content) ||
          /public\s+static\s+void\s+main\s*\(/.test(content);
        if (!isApp) {
          continue;
        }

        const pkgMatch = content.match(/package\s+([\w.]+)\s*;/);
        const classMatch = content.match(/(?:public\s+)?(?:final\s+)?class\s+(\w+)/);
        if (!classMatch) {
          continue;
        }

        const className = classMatch[1];
        const fqn = pkgMatch ? `${pkgMatch[1]}.${className}` : className;
        if (results.some((r) => r.raw.mainClass === fqn)) {
          continue;
        }

        const displayName = `${label}Java: ${className}`;
        results.push({
          name: displayName,
          type: 'java',
          raw: {
            type: 'java',
            request: 'launch',
            name: displayName,
            mainClass: fqn,
            console: 'integratedTerminal',
          },
        });
      } catch {
        // 单个文件读取失败，跳过
      }
    }
  }

  for (const folder of folders) {
    await walkDir(folder.uri, '', 0);
  }

  return results;
}
