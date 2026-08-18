# Contributing

感谢你考虑为 agent-trajectory 贡献代码。

## 开发流程

1. Fork 并克隆仓库
2. 改代码请改 `src/**/*.ts` 与 `viewer/index.html`，不要直接改生成目录 `dist/` 或 Claude 插件缓存
3. 本地验证：
   - `npm test`：CI 冒烟测试（demo 数据 → SQLite 投影 → viewer API），无需真实 Claude Code 会话
   - `npm run demo` + `npm run serve`：人工查看时间线效果
4. 提交前执行完整的 TypeScript 构建与发布校验：
   ```sh
   npm run build
   npm run validate
   ```
5. 提交 PR，附上改动说明

## 风格约定

- 零运行时依赖：所有脚本只用 Node 内置模块（`node:fs`、`node:http`、`node:sqlite` 等）
- hook 脚本必须 `exit(0)` 且不阻塞 agent 循环；失败只写日志
- 新增 hook 记录类型时，同步更新 README 的记录类型表和 viewer 的渲染分支
- 改 README 时同步更新「目录结构」和「已知限制」
