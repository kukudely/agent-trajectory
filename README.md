# agent-trajectory

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-green)](package.json)
[![CI](https://github.com/kukudely/agent-trajectory/actions/workflows/ci.yml/badge.svg)](https://github.com/kukudely/agent-trajectory/actions)

Codex 与 Claude Code 的本地「轨迹」查看器：把会话呈现为可回放时间线（提示词、工具调用、回合边界等），并提供调用详情检查器。

- **Codex**：直接只读 `~/.codex/sessions`、`archived_sessions` 与 `session_index.jsonl`，不重复采集、不安装会话 hook
- **Claude Code**：hooks 增量记录 + 官方 transcript 全量回放 + `stream-json` 采集器（路线 B，含 usage）
- **展示**：零依赖本地 Web 查看器，提供 Input/Model/Tools 概览泳道、密集事件列表和 Payload/Result/Timing 详情检查器；按 `toolUseId` 合并多数据源并按时间插入生命周期事件，纯轨迹视图按尾部分页加载
- **统计**：增量 SQLite 投影（内置 `node:sqlite`），FTS5 多会话检索与统计

## 原理

- **采集**：Claude Code 官方 transcript（`~/.claude/projects/**/*.jsonl`）已覆盖 user / assistant / tool_use / tool_result；hooks 补充生命周期与增量信息，追加到 `~/.claude/trajectories/<sessionId>.jsonl`
- **Codex 适配**：读取 Codex 原生 `rollout-*.jsonl`，将 message、custom/function tool call、tool output 和 task boundary 归一化为 Viewer 的轨迹记录；会话标题优先使用 `session_index.jsonl`
- **投影/展示**：`src/viewer/serve.ts` + `src/viewer/app.ts` + `viewer/index.html` 把轨迹与官方 transcript 按 `toolUseId` 合并渲染成时间线

## 目录结构

```
agent-trajectory/
├── .claude-plugin/
│   ├── plugin.json             # Claude Code 官方插件清单
│   └── marketplace.json        # npm 安装后供 CLI 注册的本地 Marketplace
├── hooks/hooks.json            # Claude Code hook 声明（指向 dist/hooks）
├── .agents/plugins/             # Codex 本地 Marketplace 清单
├── plugins/agent-trajectory/    # Codex 插件清单与 trajectory skill
├── src/                        # TypeScript 源码
│   ├── hooks/                  #   8 个记录 hook + 1 个可选策略 hook
│   ├── lib/record.ts           #   stdin、redact、截断、并发安全 JSONL 追加
│   ├── scripts/                #   CLI、采集、投影、发布检查与冒烟测试
│   └── viewer/                 #   HTTP 服务与浏览器端时间线逻辑
├── viewer/index.html           # 查看器 HTML/CSS 外壳
├── dist/                       # npm run build 生成；npm/Claude 插件实际执行内容
├── tsconfig.json
├── trajectory-policy.example.json
├── package.json
├── LICENSE
└── .github/workflows/ci.yml
```

## 快速开始

```powershell
npm install -g agent-trajectory
trajectory install             # 注册 Marketplace，并安装到 Claude Code user scope
trajectory install-codex       # 注册并安装 Codex 插件/skill（Codex 数据无需安装也能读取）
trajectory start               # 后台启动 Viewer，并打开 http://127.0.0.1:8611
```

安装或更新插件后，重启 Claude Code，或在活动会话中运行 `/reload-plugins`。轨迹数据仍保存在 `~/.claude/trajectories`，升级和卸载 npm 包不会删除历史记录。

不想全局安装也可以使用：

```powershell
npx agent-trajectory install
npx agent-trajectory start
```

### 常用命令

```text
trajectory install                 安装或更新 Claude Code 插件，并迁移旧版重复 Hook
trajectory install-codex           安装 Codex 插件与 trajectory skill
trajectory update                  更新 Marketplace 与插件缓存
trajectory start [--port 8611]     后台启动并打开 Viewer
trajectory start --no-open         只启动，不打开浏览器
trajectory serve [--port 8611]     前台运行 Viewer
trajectory stop                    停止由 trajectory start 管理的 Viewer
trajectory status                  查看包、插件、Viewer 和数据目录状态
trajectory doctor                  检查 Node、Claude CLI、Manifest 和运行状态
trajectory uninstall               卸载插件，保留轨迹数据
trajectory uninstall-codex         卸载 Codex 插件，保留 Codex rollout 数据
```

### 从源码开发

```sh
git clone https://github.com/kukudely/agent-trajectory.git
cd agent-trajectory

npm run demo    # 生成示例轨迹（无需真实会话）
npm run serve   # 打开 http://127.0.0.1:8611
npm run build   # 编译 TypeScript，并复制 Viewer 静态文件到 dist
npm test        # CI 冒烟测试
npm run validate
```

### 发布到 npm（维护者）

`package.json` 的 `publishConfig` 已固定到公共 npm registry，避免本机公司镜像接管发布。发布前必须同步 npm、Claude Code 与 Codex 插件清单版本；`prepack` 会自动阻止版本不一致的包：

```powershell
npm test
npm run validate
npm pack --dry-run
npm login --registry=https://registry.npmjs.org
npm publish
```

### 接入真实 Claude Code 会话

```sh
npm run setup   # 源码模式下等价于 trajectory install
# 重启 Claude Code 或运行 /reload-plugins，然后跑一个会话
# trajectory start 打开 Viewer，左侧「轨迹会话」里即出现真实轨迹
```

不想装插件、只想把官方 transcript 渲染成时间线：`trajectory-render ~/.claude/projects/<项目>/<session>.jsonl out.html`。源码开发时可用 `npm run render -- <transcript.jsonl> [out.html]`。

想临时测试而不安装：在仓库目录运行 `claude --plugin-dir .`。

## 轨迹记录格式

`~/.claude/trajectories/<sessionId>.jsonl`，每行一条 JSON，含 `schemaVersion`、`seq`（从 1 开始的文件内连续序号）与 `ts`（毫秒时间戳）。旧记录没有 `schemaVersion` 也仍可读取：

| type | 来源 hook | 内容 |
|---|---|---|
| session | SessionStart | cwd、model、source、transcriptPath |
| user | UserPromptSubmit | prompt 文本（上限 8KB） |
| tool-start | PreToolUse | toolUseId、tool、input（redact + 截断） |
| tool | PostToolUse | 同上 + result 预览（2KB） |
| permission | （策略 hook，见下） | decision: allowed / denied / asked |
| subagent-start / subagent-end | SubagentStart / SubagentStop | agentType、agentTranscriptPath |
| turn-end | Stop | lastAssistantMessage |
| session-end | SessionEnd | — |

工具耗时由查看器用 `toolUseId` 把 tool-start 与 tool 配对计算。合并视图开启时，官方 transcript 提供完整 input/result 与 assistant 文本。

## 配置

- 轨迹目录默认 `~/.claude/trajectories`，可用环境变量 `TRAJECTORY_ROOT` 覆盖（`TRANSCRIPT_ROOT` 同理，供 CI/测试使用）
- Codex 根目录默认 `~/.codex`，遵循 `CODEX_HOME`；测试或特殊部署可分别使用 `CODEX_SESSIONS_ROOT`、`CODEX_ARCHIVED_ROOT` 和 `CODEX_SESSION_INDEX` 覆盖
- 记录上限：输入 8KB、结果 2KB、提示词 8KB（`src/lib/record.ts` 顶部常量）
- 同一会话使用跨进程锁串行追加，避免并发 hook 产生重复 `seq`；读取时忽略未写完的最后一行，下一次追加会先修复该尾部
- hook 脚本一律 `exit(0)`、失败只写 `~/.claude/trajectory-errors.log`，绝不阻塞 agent 循环

## 已知限制

- **看不到「被拒绝」的工具**：PreToolUse 的 deny/ask 由 hook 的退出码决定，纯观察者无法得知。要记录权限决策需另写真正做决策的 hook（见下节）
- **官方 transcript schema 不是稳定 API**：字段可能随版本变化，查看器对未知类型宽容跳过
- **Codex rollout schema 可能演进**：当前适配 message、custom/function tool call/output、task_complete 与 turn_aborted；未知事件会被安全跳过
- **拿不到**：reasoning 内容、精确 token 用量、KV cache 状态（hooks 层面不存在）；需要这些请走 stream-json 或 Agent SDK 路线（见「更进一步」）
- **Claude Code 版本**：npm 安装器依赖 `claude plugin` CLI；旧版本若没有该命令，请先升级 Claude Code
- **Windows**：hook 命令经 shell 执行，绝对路径写法最稳；脚本用 `os.homedir()`，不依赖 `$HOME`
- **合并时序**：优先使用官方 transcript 的 `timestamp`；个别无时间戳记录回退到 transcript 行序，并按 `toolUseId` 关联工具事件

## 权限决策策略 hook（可选，①）

纯记录者看不到 deny/ask——决策就是 hook 的退出码。`src/hooks/policy-tool-use.ts` 是真正做决策的 PreToolUse hook：匹配 `~/.claude/trajectory-policy.json`（示例见 `trajectory-policy.example.json`）后以 `exit(0)` 放行 / `exit(1)` 询问 / `exit(2)` 拒绝，并把决策追加为 `{type:'permission', decision}` 记录。内部出错时 fail-open（exit 0），策略 bug 不会拖垮 agent。

启用：在自定义构建中把 `hooks/hooks.json` 的 `PreToolUse` 数组追加一组，然后重新执行 `trajectory install`：

```json
"PreToolUse": [
  { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/pre-tool-use.js\"" }] },
  { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/policy-tool-use.js\"" }] }
]
```

> 注意：这改变了 agent 行为（工具可能被拦下），与纯记录分开配置。

## stream-json 采集器（路线 B，②）

不依赖 hooks，消费 headless 输出，补上 token 用量与 assistant 文本：

```sh
claude --output-format stream-json -p "任务" | trajectory-collect
trajectory-collect --file run.log                            # 离线回放
trajectory-collect --file run.log --out D:/trajectories
```

写入与 hooks 相同的轨迹格式：`session`（含 model）、`assistant`（文本）、`tool-start`/`tool`（input/result）、`usage`（input/output/cache读/cache写，累计）、`session-end`。查看器直接渲染这些卡片。

## SQLite 投影与统计（③）

把轨迹导入 SQLite（内置 `node:sqlite`，需 Node ≥ 22.13），支持多会话检索与统计：

```sh
trajectory-project --report                       # 导入 + 统计表
trajectory-project --sql "SELECT session_id, COUNT(*) FROM records GROUP BY 1"
```

之后 viewer 自动获得两个能力（默认读 `~/.claude/trajectories/trajectory.db`）：
- **统计**：侧栏「统计」按钮 → 每会话记录数/时长/提示词/工具/拒绝/子代理 + 高频工具
- **全局检索**：侧栏搜索框 → 跨会话 FTS5 全文检索，点结果直接打开对应会话

重复执行投影时只重建新增或文件状态发生变化的会话，并清理已删除 JSONL 对应的旧索引。查看器关闭“合并官方 transcript”后，初次只加载最后 200 条轨迹，并可逐页加载更早记录；合并模式为保证 `toolUseId` 跨来源配对准确，仍会读取完整轨迹和 transcript。

查看器每 3 秒检查当前轨迹和 transcript 的文件版本；停留在时间线尾部时自动加载新记录，向上查看历史时暂停自动跟随。“刷新”会同时刷新会话列表和当前时间线。点击事件行或顶部概览色块可在右侧检查 Summary、Payload、Result 和 Timing；Schema 标签目前仅显示占位信息。`turn-end` 表示一个 Agent 回合结束，`session-end` 才表示整个会话结束。

FTS5 使用 `unicode61` 分词和字面短语查询，优先处理完整词或连续短语；没有 FTS 命中时会自动回退到原有 `LIKE` 子串检索，保留中文长 token 中间子串的召回能力。

## 记录类型补充

| type | 来源 | 内容 |
|---| --- | --- |
| assistant | stream-json 采集器 | 助手文本（30KB 上限） |
| usage | stream-json 采集器 | inputTokens / outputTokens / cacheReadInputTokens / cacheCreationInputTokens |
| permission | 策略 hook | decision: allowed / denied / asked + reason |
## 更进一步

- 想拿 usage / KV cache / 完整事件流：`claude --output-format stream-json`（路线 B）或 `@anthropic-ai/claude-agent-sdk` 的 `query()` 事件（路线 C）——那已是「造 harness」而非插件
- 多会话检索/统计：把轨迹导入 SQLite 做投影（标题、耗时、工具频次），对应 DSH 的 projection 层

## 参考

- Hooks: https://code.claude.com/docs/en/hooks
- Plugins: https://code.claude.com/docs/en/plugins-reference

## 贡献

欢迎 PR！开发流程与风格约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。核心要求：零运行时依赖、hook 不阻塞 agent 循环、新增记录类型同步更新查看器与本文档。

## 开源协议

[MIT](LICENSE) © 2026 agent-trajectory contributors
