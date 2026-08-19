---
name: trajectory
description: Open or troubleshoot the Agent Trajectory local viewer for Codex sessions and Claude Code trajectories. Use when the user asks to inspect, view, replay, or debug an agent trajectory or local Codex rollout.
---

# Agent Trajectory

Use the globally installed `agent-trajectory` package to inspect local sessions.

1. Run `trajectory status` to check the viewer.
2. If stopped, run `trajectory start`. This starts the local server and opens `http://127.0.0.1:8611/`.
3. The viewer reads Codex sessions directly from `${CODEX_HOME:-~/.codex}/sessions` and `archived_sessions`. It does not install recording hooks or copy session data.
4. For startup problems, run `trajectory doctor` and report its exact output.

Do not expose raw rollout contents in chat unless the user explicitly asks. Prefer opening the local viewer.
