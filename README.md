# agent-trajectory

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-green)](package.json)
[![CI](https://github.com/kukudely/agent-trajectory/actions/workflows/ci.yml/badge.svg)](https://github.com/kukudely/agent-trajectory/actions)

给 Claude Code 的「轨迹」插件：把每次会话记录成可回放的时间线（提示词、工具调用、权限决策、子代理、回合边界、token 用量），并用本地网页查看。

- **采集**：hooks 增量记录 + 官方 transcript 全量回放 + `stream-json` 采集器（路线 B，含 usage）
- **展示**：零依赖本地 Web 查看器，提供 Input/Model/Tools 概览泳道、密集事件列表和 Payload/Result/Timing 详情检查器；按 `toolUseId` 合并多数据源并按时间插入生命周期事件，纯轨迹视图按尾部分页加载
- **统计**：增量 SQLite 投影（内置 `node:sqlite`），FTS5 多会话检索与统计

## 原理

- **采集**：Claude Code 官方 transcript（`~/.claude/projects/**/*.jsonl`）已覆盖 user / assistant / tool_use / tool_result；hooks 补充生命周期与增量信息，追加到 `~/.claude/trajectories/<sessionId>.jsonl`
- **投影/展示**：`viewer/serve.mjs` + `viewer/index.html` 把轨迹与官方 transcript 按 `toolUseId` 合并渲染成时间线

## 目录结构

```
agent-trajectory/
├── plugin.json                 # Claude Code 插件清单（hooks 配置）
├── hooks/                      # 9 个 hook 脚本：8 个记录 + 1 个可选策略 hook
├── lib/record.mjs              # 共享：stdin 解析、redact、截断、JSONL 追加
├── viewer/                     # 本地网页查看器（零依赖）
│   ├── serve.mjs               #   http 服务 + API（127.0.0.1:8611）
│   └── index.html              #   时间线 UI（轨迹 + transcript 合并）
├── scripts/
│   ├── demo.mjs                #   生成示例轨迹
│   ├── render-transcript.mjs   #   直接把官方 transcript 渲染为 HTML
│   ├── install.mjs             #   安装到 ~/.claude/plugins/agent-trajectory
│   ├── collect-stream-json.mjs #   stream-json 采集器（token 用量）
│   ├── project-sqlite.mjs      #   SQLite 投影与统计
│   └── smoke.mjs               #   CI 冒烟测试（npm test）
├── trajectory-policy.example.json
├── package.json
├── LICENSE
└── .github/workflows/ci.yml
```

## 快速开始

```sh
git clone https://github.com/kukudely/agent-trajectory.git
cd agent-trajectory

npm run demo    # 生成示例轨迹（无需真实会话）
npm run serve   # 打开 http://127.0.0.1:8611
npm test        # CI 冒烟测试
```

### 接入真实 Claude Code 会话

```sh
npm run setup   # 等价 node scripts/install.mjs：安装到 ~/.claude/plugins/agent-trajectory（绝对路径，Windows 最稳）
# 重启 claude，/plugin 确认 trajectory 已启用，然后跑一个会话
# 重新打开查看器，左侧「轨迹会话」里即出现真实轨迹
```

不想装插件、只想把官方 transcript 渲染成时间线：`node scripts/render-transcript.mjs ~/.claude/projects/<项目>/<session>.jsonl out.html`

想先用项目级 `settings.json` 试 hook（不装插件）：把 `plugin.json` 里任意一组 hooks 拷进 `.claude/settings.json`，命令改成绝对路径。

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
- 记录上限：输入 8KB、结果 2KB、提示词 8KB（`lib/record.mjs` 顶部常量）
- 同一会话使用跨进程锁串行追加，避免并发 hook 产生重复 `seq`；读取时忽略未写完的最后一行，下一次追加会先修复该尾部
- hook 脚本一律 `exit(0)`、失败只写 `~/.claude/trajectory-errors.log`，绝不阻塞 agent 循环

## 已知限制

- **看不到「被拒绝」的工具**：PreToolUse 的 deny/ask 由 hook 的退出码决定，纯观察者无法得知。要记录权限决策需另写真正做决策的 hook（见下节）
- **官方 transcript schema 不是稳定 API**：字段可能随版本变化，查看器对未知类型宽容跳过
- **拿不到**：reasoning 内容、精确 token 用量、KV cache 状态（hooks 层面不存在）；需要这些请走 stream-json 或 Agent SDK 路线（见「更进一步」）
- **`${CLAUDE_PLUGIN_ROOT}` 个别版本/平台不注入**（如 anthropics/claude-code#27145 的 SessionStart 场景），此时用 `scripts/install.mjs` 的绝对路径版
- **Windows**：hook 命令经 shell 执行，绝对路径写法最稳；脚本用 `os.homedir()`，不依赖 `$HOME`
- **合并时序**：官方 transcript 无时间戳，跨来源的顺序以 transcript 行序为准；按 `toolUseId` 关联

## 权限决策策略 hook（可选，①）

纯记录者看不到 deny/ask——决策就是 hook 的退出码。`hooks/policy-tool-use.mjs` 是真正做决策的 PreToolUse hook：匹配 `~/.claude/trajectory-policy.json`（示例见 `trajectory-policy.example.json`）后以 `exit(0)` 放行 / `exit(1)` 询问 / `exit(2)` 拒绝，并把决策追加为 `{type:'permission', decision}` 记录。内部出错时 fail-open（exit 0），策略 bug 不会拖垮 agent。

启用：把 `plugin.json` 的 `PreToolUse` 数组追加一组（`install.mjs` 安装后改 `~/.claude/plugins/agent-trajectory/plugin.json`）：

```json
"PreToolUse": [
  { "matcher": "*", "hooks": [{ "type": "command", "command": "<绝对路径>/hooks/pre-tool-use.mjs" }] },
  { "matcher": "*", "hooks": [{ "type": "command", "command": "<绝对路径>/hooks/policy-tool-use.mjs" }] }
]
```

> 注意：这改变了 agent 行为（工具可能被拦下），与纯记录分开配置。

## stream-json 采集器（路线 B，②）

不依赖 hooks，消费 headless 输出，补上 token 用量与 assistant 文本：

```sh
claude --output-format stream-json -p "任务" | node scripts/collect-stream-json.mjs
node scripts/collect-stream-json.mjs --file run.log          # 离线回放
node scripts/collect-stream-json.mjs --file run.log --out D:/trajectories
```

写入与 hooks 相同的轨迹格式：`session`（含 model）、`assistant`（文本）、`tool-start`/`tool`（input/result）、`usage`（input/output/cache读/cache写，累计）、`session-end`。查看器直接渲染这些卡片。

## SQLite 投影与统计（③）

把轨迹导入 SQLite（内置 `node:sqlite`，需 Node ≥ 22.13），支持多会话检索与统计：

```sh
node scripts/project-sqlite.mjs --report          # 导入 + 统计表
node scripts/project-sqlite.mjs --sql "SELECT session_id, COUNT(*) FROM records GROUP BY 1"
```

之后 viewer 自动获得两个能力（默认读 `~/.claude/trajectories/trajectory.db`）：
- **统计**：侧栏「统计」按钮 → 每会话记录数/时长/提示词/工具/拒绝/子代理 + 高频工具
- **全局检索**：侧栏搜索框 → 跨会话 FTS5 全文检索，点结果直接打开对应会话

重复执行投影时只重建新增或文件状态发生变化的会话，并清理已删除 JSONL 对应的旧索引。查看器关闭“合并官方 transcript”后，初次只加载最后 200 条轨迹，并可逐页加载更早记录；合并模式为保证 `toolUseId` 跨来源配对准确，仍会读取完整轨迹和 transcript。

查看器每 3 秒检查当前轨迹和 transcript 的文件版本；停留在时间线尾部时自动加载新记录，向上查看历史时暂停自动跟随。“刷新”会同时刷新会话列表和当前时间线。点击事件行或顶部概览色块可在右侧检查 Payload、Result、Schema 和 Timing。`turn-end` 表示一个 Agent 回合结束，`session-end` 才表示整个会话结束。

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
