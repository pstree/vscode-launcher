# Multi Launch

A VS Code extension that lets you **multi-select** launch configurations from `launch.json` in the **Run & Debug** view and **launch them all at once**. Java configurations automatically get JMX remote ports injected (randomly allocated, conflict-free), and the applications' own listening ports (e.g. the Spring Boot Tomcat port) are shown while they run.

## Features

- **Persistent multi-select view**: Adds a "Multi Launch" view under the **Run & Debug** sidebar that lists every top-level configuration from `launch.json`, all visible by default.
- **Grouped display**: The view is split into a **Running** group and a **Not running** group. Started items move to the Running group, so status is always clear at a glance.
- **Free multi-selection**: Native TreeView checkboxes — tick the boxes you want, all others stay untouched.
- **Batch launch in one click**: After selecting configurations, click **Launch Selected** in the view title bar to start them all simultaneously.
- **Per-item inline actions**: Each configuration has a `[▶ Launch]` / `[■ Stop]` inline button for individual start/stop.
- **Click to focus output**: Clicking a running item focuses its integrated terminal so you can read that program's output.
- **Java JMX auto-injection**: When a configuration of type `java` starts, JMX remote `vmArgs` are appended automatically with randomly allocated, batch-conflict-free ports. Non-Java configurations launch unchanged.
- **Application port display**: A running item shows the application's own listening port (e.g. `:8080`); if it can't be detected, nothing is shown (never faked). The JMX debug port is not shown in the view.
- **Disk-unchanged**: All injection happens on an in-memory copy of the launch configuration, so your `launch.json` file stays exactly as you wrote it.
- **Graphical launch config editor**: The **Configure Launch** command (`multiLauncher.configureLaunch`) opens a webview editor where you can:
  - Browse every configuration with its parameters.
  - Edit any parameter (string / number / boolean / array / object), add or remove parameters, and save directly back to `launch.json`.
  - **Auto-scan the project** ("一键新增" / *Scan & Add*) to detect launchable entries for **Node.js** (`package.json` `main` and `start`/`dev`/`serve` scripts), **Python** (entry files like `main.py`, `app.py`, …), and **Java** (classes with a `main` method), then append them automatically.
  - **Batch-add `envFile`** to every configuration at once.
  - Delete configurations.
- **Accurate OS-level port detection**: For Java launches using the integrated terminal, the app port is detected by probing the actual OS listening sockets of the launched process (via `Get-NetTCPConnection` / `lsof` / `ss`), correctly attributed per process and excluding debug/JMX ports.
- **Robust stop**: Stopping a configuration kills the process at the OS level by a unique marker, disconnects the debug session, and closes the associated terminal. Failed starts keep their terminal open so you can inspect the error log.

## Install & Run (Development)

```bash
npm install

# or npm run watch for continuous compile
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

Press `F5` to debug in the Extension Development Host.

## Usage

1. Open a workspace that contains a `launch.json`.
2. In the **Run & Debug** sidebar, find the **Multi Launch** view.
3. Tick the checkboxes for the configurations you want, then click the title bar's ▶ **Launch Selected**; or click the `▶` inline button on an item to start it individually.
4. Running items show `●` plus the application port (e.g. `:8080`). Click `■` to stop.
5. Click **Configure Launch** (gear icon) in the view title bar to open the graphical editor for adding, editing, or scanning configurations.

> **Note**: Only sessions started by this extension appear in the **Running** group and are managed by **Stop**. Configurations you start manually from the native Run & Debug panel are not taken over by this extension.

## Settings

Available in settings:

| Setting | Description | Default |
| --- | --- | --- |
| `multiLauncher.portPatterns` | Array of regex strings used to parse application ports from debug output (appended after the built-in rules) | `[]` |

Built-in port parsing rules (matched in order, first hit wins):

- `Tomcat started on port(s): <port>` (Spring Boot)
- `Tomcat initialized with port(s): <port>`
- `(Netty|Undertow|Jetty|WebServer) started on port(s): <port>`
- `Started ... on port(s) <port>`
- `Listening on ... <port>` / `Server started on ... <port>` / `App running on ... <port>`
- `Local: http://...:<port>` / `Network: http://...:<port>`
- Generic fallback: `started on port ... <port>` / `port: <port>` / `port=<port>`

## Port Allocation Rules (Java)

- Base address: `base = 61000 + (hash(configName) % 4000)`, landing in `61000–64999`.
- `jmx = base`, `rmi = base + 1`.
- If a conflict occurs with another configuration in the same batch launch, or the port is already taken locally, `base += 2` and retry until a free pair is found.
- The `hash` is stable for a given config name, so restarts keep the same port; within a multi-select batch, offsets are applied to avoid conflicts.
- No cross-session persistence — ports are re-probed on every launch.

## Application Port Detection

When a Java configuration launches in the integrated terminal, the Debug Adapter Protocol may not relay the program's stdout, so ports can't be parsed from logs alone. The extension instead:

1. Detects the launched process and its child processes via a unique marker (`-DmultiLauncher.id=...`).
2. Queries the OS for TCP **LISTEN** sockets owned by those PIDs (`Get-NetTCPConnection` on Windows; `lsof`/`ss` on macOS/Linux).
3. Excludes known debug/JMX ports and any JDWP port found in the process command line, then picks the best candidate (preferring standard ports `< 32768`).

If a port is detected in the logs via the DAP tracker, that takes precedence and OS polling stops.

## Scope & Requirements

- Only **top-level** `configurations` in `launch.json` are supported; `compounds` (compound configurations) are not.
- Requires VS Code `>= 1.84` (needed for TreeView multi-select and checkboxes).
