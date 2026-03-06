# 扩展 system-select.ts 原理分析

## 一、功能概述

`system-select.ts` 是 pi-code-agent 的一个扩展，提供系统提示词切换功能。它从多个来源扫描 agent 定义文件（`.md` 格式），允许用户通过 `/system` 命令选择不同的系统提示词，并自动切换到对应的工具集。

## 二、核心能力

该扩展具备两项核心能力：

1. **切换系统提示词** — 将用户选择的 agent 定义的 body 内容作为前缀，叠加到 Pi 默认系统提示词之前
2. **切换工具集** — 根据 agent 定义中声明的 tools 字段，动态调整可用工具

## 三、Agent 定义文件格式

扩展扫描的 agent 文件采用 Frontmatter 格式：

```markdown
---
name: security-audit
description: 专注于代码安全审计的助手
tools: read,bash,grep,find
---

你是一个专业的安全审计专家。在进行任何代码审查时，必须优先考虑潜在的安全漏洞，包括但不限于 SQL 注入、XSS、CSRF、权限提升等问题。
```

字段说明：
- `name`：agent 名称（用作标识）
- `description`：描述信息（用于 UI 显示）
- `tools`：逗号分隔的工具列表（可选，指定该 agent 可用的工具）
- 文件 body：自定义的系统提示词内容

## 四、扫描机制

### 扫描目录

扩展会扫描以下目录中的 agent 定义文件：

| 路径 | 来源 |
|------|------|
| `.pi/agents/` | 项目本地 |
| `.claude/agents/` | 项目本地 |
| `.gemini/agents/` | 项目本地 |
| `.codex/agents/` | 项目本地 |
| `~/.pi/agent/agents/` | 全局用户 |
| `~/.claude/agents/` | 全局用户 |
| `~/.gemini/agents/` | 全局用户 |
| `~/.codex/agents/` | 全局用户 |

### 解析逻辑

1. 扫描目录中所有 `.md` 文件
2. 解析 Frontmatter 提取 name、description、tools 字段
3. 文件剩余部分作为 body（系统提示词内容）
4. 按名称去重，保留首次发现的版本

## 五、工作流程

### 1. 会话初始化（session_start）

- 扫描所有配置的目录
- 解析 agent 定义文件
- 保存默认工具集（`defaultTools`）
- 更新状态栏显示当前为 "System Prompt: Default"
- 发送通知告知用户已加载的 agent 数量

### 2. 用户执行 /system 命令

- 显示 agent 选择对话框（包含名称、描述、来源）
- 提供 "Reset to Default" 选项用于恢复默认

### 3. 选择 agent 后的处理

```typescript
// 1. 记录当前激活的 agent
activeAgent = agent;

// 2. 设置工具集
if (agent.tools.length > 0) {
    pi.setActiveTools(agent.tools);  // 使用 agent 声明的工具
} else {
    pi.setActiveTools(defaultTools); // 回退到默认工具
}

// 3. 更新状态栏
ctx.ui.setStatus("system-prompt", `System Prompt: ${displayName(agent.name)}`);
```

### 4. 实际切换（before_agent_start）

当用户发送消息、AI 开始处理前，扩展通过 `before_agent_start` 事件返回新的系统提示词：

```typescript
pi.on("before_agent_start", async (event, _ctx) => {
    if (!activeAgent) return;
    return {
        systemPrompt: activeAgent.body + "\n\n" + event.systemPrompt,
    };
});
```

关键点：
- `event.systemPrompt` 是 Pi 的默认系统提示词（包含工具描述、指南等）
- `activeAgent.body` 是 agent 文件中定义的自定义提示词
- 两者通过换行符连接，自定义内容在前，默认内容在后
- 这样既保留了 Pi 核心功能（工具使用说明），又叠加了 agent 特定的行为指导

## 六、与预设系统的区别

与 `preset.ts` 扩展相比，`system-select.ts` 采用了更轻量的设计：

| 特性 | preset.ts | system-select.ts |
|------|-----------|------------------|
| 配置存储 | 代码或配置文件 | Markdown 文件 |
| 模型切换 | 支持 | 不支持 |
| 工具切换 | 支持 | 支持 |
| 提示词修改 | 通过 instructions 字段 | 通过文件 body |
| 触发方式 | /preset 命令、--preset 参数、Ctrl+Shift+U | /system 命令 |

`system-select.ts` 的优势在于使用 Markdown 文件存储 agent 定义，便于非开发者用户编辑和维护。

## 七、状态管理

扩展内部维护三个关键状态变量：

```typescript
let activeAgent: AgentDef | null = null;    // 当前选中的 agent
let allAgents: AgentDef[] = [];             // 扫描到的所有 agent
let defaultTools: string[] = [];            // 默认工具集
```

- `session_start` 时重置 `activeAgent` 为 null
- 切换到 "Reset to Default" 时也会重置 `activeAgent`
- 状态栏通过 `ctx.ui.setStatus("system-prompt", ...)` 更新

## 八、交互流程图

```
用户启动 pi（加载扩展）
         ↓
   session_start 事件
         ↓
扫描目录 → 解析 agent 文件 → 加载到 allAgents
         ↓
用户输入 /system
         ↓
显示选择对话框
         ↓
┌─────────────────────────────────────┐
│ 用户选择某个 agent 或 Reset        │
└─────────────────────────────────────┘
         ↓
   更新 activeAgent + 工具集 + 状态栏
         ↓
用户输入消息
         ↓
   before_agent_start 事件
         ↓
返回新的 systemPrompt（agent.body + 默认）
         ↓
AI 使用修改后的提示词开始处理
```

## 九、设计要点

1. **向后兼容**：未选择 agent 时，使用 Pi 默认提示词
2. **工具回退**：agent 未声明工具时，使用默认工具集
3. **多源聚合**：支持从多个目录扫描，统一去重
4. **渐进增强**：通过 Markdown 文件提供声明式配置
5. **用户反馈**：通过通知和状态栏提供清晰的交互反馈
