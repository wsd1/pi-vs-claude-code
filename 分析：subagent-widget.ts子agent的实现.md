# 分析-subagent-widget.ts 子agent的实现

## 概述

`subagent-widget.ts` 是 pi 扩展示例中实现子agent功能的核心文件。它通过启动独立进程运行 `pi --mode json`，配合 session 文件实现多轮对话，并通过 widget 系统实现实时状态显示。

本文档从多个维度分析其实现原理，并提供简化版的操控示例。

---

## 一、subagent-widget.ts 原理分析

### 1. 扩展 subAgent 的基本原理

#### 进程级隔离

每个 subagent 是主进程通过 `child_process.spawn()` 启动的独立 `pi` 命令行进程：

```typescript
const proc = spawn("pi", [
  "--mode", "json",           // JSON 事件流输出
  "-p",                       // print 模式，输出完后退出生效
  "--session", sessionFile,   // 持久化 session 路径
  "--no-extensions",          // 隔离环境
  "--model", model,
  "--tools", "read,bash,grep,find,ls",
  "--thinking", "off",
  prompt,                     // 用户任务作为最后参数
], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env },
});
```

关键参数说明：

| 参数 | 作用 |
|------|------|
| `--mode json` | 输出所有事件为 JSON 行格式 |
| `-p` | 单轮交互，完成后退出 |
| `--session <file>` | 指定 session 文件路径 |
| `--no-extensions` | 禁用扩展，确保隔离 |

#### Widget 可视化

使用 `DynamicBorder` 和 `Container` 为每个 subagent 创建实时状态显示：

```typescript
widgetCtx.ui.setWidget(`sub-${id}`, (_tui, theme) => {
  return {
    render(width: number): string[] {
      // 显示：状态图标、任务预览、耗时、工具调用数、最新输出
      return [/* 格式化字符串 */];
    },
    invalidate() { /* 触发重绘 */ }
  };
});
```

#### 双重入口

提供工具 + 命令两种交互方式：

- **工具**：`subagent_create`, `subagent_continue`, `subagent_remove`, `subagent_list`
- **命令**：`/sub`, `/subcont`, `/subrm`, `/subclear`

---

### 2. subAgent 的生命周期

| 阶段 | 状态 | 说明 |
|------|------|------|
| 创建 | `running` | 首次创建或被继续时 |
| 执行中 | `running` | 实时更新 elapsed、toolCount |
| 结束 | `done` / `error` | 进程退出后根据 exit code 决定 |
| 继续 | `running` | `/subcont` 触发，turnCount++ |
| 移除 | - | `/subrm` 删除，进程被 kill |

关键状态结构：

```typescript
interface SubState {
  id: number;
  status: "running" | "done" | "error";
  task: string;
  textChunks: string[];
  toolCount: number;
  elapsed: number;
  sessionFile: string;   // 持久化会话文件路径
  turnCount: number;     // 继续次数，/subcont 会递增
  proc?: ChildProcess;   // 进程引用（运行时）
}
```

状态转换图：

```
创建 ──► running ──┬──► done
                   │
                   └──► error
                    
继续 ──► running ──┬──► done
                   │
                   └──► error

移除 ──► (kill proc) ──► delete from Map
```

---

### 3. subAgent 的 session 归属

**完全独立，不合并到主 agent 的 session**

每个 subagent 有独立的 session 文件：

```typescript
function makeSessionFile(id: number): string {
  const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
}
```

- 存储位置：`~/.pi/agent/sessions/subagents/subagent-{id}-{timestamp}.jsonl`
- 格式：JSONL（每行一个 JSON 事件）
- **/subcont 复用**：继续时使用相同的 `sessionFile`，subagent 会加载完整历史继续对话

---

### 4. 主 agent 的 session 受到从 agent 的怎样影响

**主 agent session 完全不受 subagent 影响，但可以通过 API 注入结果**

交互方式：

1. **Subagent 结果返回**：通过 `pi.sendMessage()` 以 `customType: "subagent-result"` 发送结果

```typescript
pi.sendMessage({
  customType: "subagent-result",
  content: `Subagent #${state.id} finished "${prompt}"...`,
  display: true,
}, { deliverAs: "followUp", triggerTurn: true });
```

2. **根据文档说明**：`sendMessage()` 发送的消息**始终参与 LLM 上下文**，无论 `display` 值如何

3. 这条消息作为 **follow-up** 插入主对话流，可在下一轮继续追问

#### 数据流总览

```
用户输入: /sub list files and summarize
        ↓
    扩展解析
        ↓
subagent 独立进程 ← 命令作为参数传入
        ↓
subagent 独立 session 文件 ← subagent 处理全过程
        ↓
pi.sendMessage() ──────────────────────────────────────┐
        │                                                 │
        ▼                                                 ▼
主 agent session (作为 custom role)            TUI 显示结果
        │                                                 │
        ▼                                                 ▼
LLM 上下文 (参与)                              用户可见
```

---

## 二、JSON 模式 Pi-agent 操控模式总结

### 1. 输入

| 输入来源 | 形式 | 处理方式 |
|---------|------|---------|
| `/sub <task>` 命令 | 字符串 | 解析任务文本，作为子进程启动参数 |
| `/subcont <id> <prompt>` | 字符串 | 解析 id 和后续指令，复用已有 session |
| `subagent_create` 工具 | JSON 参数 | 同上，通过工具参数传入 |

### 2. 输出

子进程 stdout 输出 JSON 事件流，扩展解析处理：

```typescript
proc.stdout!.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  
  for (const line of lines) {
    const event = JSON.parse(line);
    
    // 处理不同事件类型
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta") {
        state.textChunks.push(delta.delta || "");
      }
    } else if (event.type === "tool_execution_start") {
      state.toolCount++;
    }
  }
});
```

主要事件类型：

| 事件 | 说明 |
|------|------|
| `agent_start` | agent 开始处理 |
| `turn_start` | 新 turn 开始 |
| `message_start` | 消息开始 |
| `message_update` | 流式更新（text_delta, thinking_delta, toolcall_delta） |
| `message_end` | 消息结束 |
| `turn_end` | turn 结束 |
| `tool_execution_start` | 工具开始执行 |
| `tool_execution_end` | 工具执行完成 |
| `agent_end` | agent 完成 |

### 3. 状态控制

使用内存 Map 管理所有 subagent：

```typescript
const agents: Map<number, SubState> = new Map();
```

### 4. UI 组织显示

通过 widget 系统实现实时状态显示：

```typescript
// 注册 widget
widgetCtx.ui.setWidget(`sub-${id}`, (_tui, theme) => {
  return {
    render(width: number): string[] {
      // 渲染状态：图标、任务、时间、工具数、最新输出行
      return [/* 格式化字符串 */];
    },
    invalidate() { /* 触发重绘 */ }
  };
});

// 定时更新
setInterval(() => {
  state.elapsed = Date.now() - startTime;
  updateWidgets();  // 触发所有 widget 重绘
}, 1000);
```

---

## 三、简化版示例代码

```typescript
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 简化版 JSON 模式 pi-agent 控制器
 * 
 * 核心原理：
 * 1. 启动子进程 pi --mode json -p
 * 2. 解析 stdout 的 JSON 事件流
 * 3. 通过 session 文件实现多轮对话
 */

interface AgentState {
  id: number;
  sessionFile: string;    // 持久化 session 文件路径
  status: "running" | "done" | "error";
  messages: string[];
  toolCount: number;
}

class JsonAgentController {
  private agents = new Map<number, AgentState>();
  private nextId = 1;

  // ============ 核心：启动 JSON 模式 agent ============
  
  spawnAgent(prompt: string): number {
    const id = this.nextId++;
    const sessionFile = this.makeSessionFile(id);

    // 启动子进程
    const proc = spawn("pi", [
      "--mode", "json",
      "-p",
      "--session", sessionFile,
      "--no-extensions",
      "--model", "openrouter/google/gemini-3-flash-preview",
      "--tools", "read,bash",
      prompt,  // 任务作为命令行参数
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    // 初始化状态
    const state: AgentState = {
      id,
      sessionFile,
      status: "running",
      messages: [],
      toolCount: 0,
    };
    this.agents.set(id, state);

    // 处理输出
    let buffer = "";
    proc.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        this.handleEvent(state, line);
      }
    });

    proc.on("close", (code) => {
      state.status = code === 0 ? "done" : "error";
      console.log(`[Agent #${id}] ${state.status}`);
    });

    return id;
  }

  // ============ 核心：继续对话 ============
  
  continueAgent(id: number, prompt: string): void {
    const state = this.agents.get(id);
    if (!state || state.status === "running") {
      console.error(`Agent #${id} not found or running`);
      return;
    }

    // 复用 session 文件，继续对话
    const proc = spawn("pi", [
      "--mode", "json",
      "-p",
      "--session", state.sessionFile,  // 关键：使用同一 session
      "--no-extensions",
      prompt,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    state.status = "running";
    let buffer = "";
    
    proc.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        this.handleEvent(state, line);
      }
    });

    proc.on("close", (code) => {
      state.status = code === 0 ? "done" : "error";
    });
  }

  // ============ 核心：解析 JSON 事件 ============
  
  private handleEvent(state: AgentState, line: string): void {
    if (!line.trim()) return;
    
    try {
      const event = JSON.parse(line);
      
      switch (event.type) {
        case "message_update":
          // 处理 LLM 消息
          const msg = event.assistantMessageEvent;
          if (msg?.type === "text_delta") {
            state.messages.push(msg.delta || "");
          }
          break;
          
        case "tool_execution_start":
          // 工具开始执行
          state.toolCount++;
          console.log(`[Agent #${state.id}] Tool: ${event.toolName}`);
          break;
          
        case "tool_result":
          // 工具执行结果
          console.log(`[Agent #${state.id}] Tool result received`);
          break;
          
        case "turn_end":
          // 单轮结束
          console.log(`[Agent #${state.id}] Turn ended`);
          break;
      }
    } catch (e) {
      // 非 JSON 行（如纯文本输出）
      state.messages.push(line);
    }
  }

  // ============ 会话文件管理 ============
  
  private makeSessionFile(id: number): string {
    const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `agent-${id}-${Date.now()}.jsonl`);
  }

  // ============ 状态查询 ============
  
  getAgentState(id: number): AgentState | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentState[] {
    return Array.from(this.agents.values());
  }

  // ============ 生命周期管理 ============
  
  killAgent(id: number): void {
    const state = this.agents.get(id);
    if (state) {
      // 通过 session 文件查找并 kill 进程（略）
      this.agents.delete(id);
    }
  }

  killAll(): void {
    for (const [id] of this.agents) {
      this.killAgent(id);
    }
  }
}

// ============ 使用示例 ============

async function main() {
  const controller = new JsonAgentController();

  // 1. 启动第一个 agent
  console.log("=== Spawn Agent #1 ===");
  const id1 = controller.spawnAgent("list files in /home");
  
  // 等待执行完成
  await new Promise(r => setTimeout(r, 5000));
  
  // 2. 查看结果
  const state1 = controller.getAgentState(id1);
  console.log(`Status: ${state1?.status}`);
  console.log(`Tools used: ${state1?.toolCount}`);
  console.log(`Output: ${state1?.messages.join("").slice(0, 200)}`);

  // 3. 继续对话
  console.log("\n=== Continue Agent #1 ===");
  controller.continueAgent(id1, "now count how many files");
  
  await new Promise(r => setTimeout(r, 5000));
  
  const state1b = controller.getAgentState(id1);
  console.log(`Output after continue: ${state1b?.messages.join("").slice(0, 200)}`);

  // 4. 清理
  controller.killAll();
}

main();
```

---

## 四、RPC 模式概述

### 与 JSON 模式的区别

| 特性 | JSON 模式 (`--mode json -p`) | RPC 模式 (`--mode rpc`) |
|------|-------------------------------|------------------------|
| 进程生命周期 | 每轮交互后退出 | 持久运行，stdin/stdout 交互 |
| 通信方式 | stdout 单向事件流 | stdin + stdout 双向交互 |
| 控制能力 | 只能被动接收事件 | 可发送命令控制 agent |
| 多轮对话 | 通过 session 文件实现 | 单一进程内自然支持 |
| 适用场景 | 后台任务、事件记录 | IDE 集成、精确控制 |

### RPC 模式特点

1. **持久化进程**：启动后不退出，通过 stdin 发送命令

2. **命令-响应协议**：
   - 发送命令：`{"type": "prompt", "message": "..."}`
   - 接收响应：`{"type": "response", "command": "prompt", "success": true}`
   - 接收事件：JSON 事件流到 stdout

3. **关键命令**：
   - `prompt`：发送用户消息
   - `steer`：插入 steering 消息（中断当前执行）
   - `follow_up`：插入 follow-up 消息（等待完成后处理）
   - `abort`：中止当前操作
   - `new_session`：开始新会话
   - `get_state`：获取当前状态
   - `get_messages`：获取所有消息

4. **示例**（Python）：
   ```python
   import subprocess
   import json

   proc = subprocess.Popen(
       ["pi", "--mode rpc", "--no-session"],
       stdin=subprocess.PIPE, 
       stdout=subprocess.PIPE,
       text=True
   )

   # 发送 prompt
   proc.stdin.write(json.dumps({"type": "prompt", "message": "Hello!"}) + "\n")
   proc.stdin.flush()

   # 接收事件
   for line in proc.stdout:
       event = json.loads(line)
       # 处理事件...
   ```

### 选择建议

- **JSON 模式**：适合后台任务、并行处理、简单的事件记录
- **RPC 模式**：适合需要精确控制、复杂交互的应用场景（如 IDE 集成）

---

## 五、关键 API 调用对照表

| 功能 | 调用的 API/机制 |
|------|---------------|
| 启动 agent | `child_process.spawn("pi", ["--mode", "json", ...])` |
| 接收输出 | `proc.stdout.on("data", ...)` 解析 JSON 事件 |
| 持久化 session | `--session <file>` 参数 + JSONL 格式 |
| 多轮对话 | 复用同一 `--session` 文件路径 |
| 结果返回主 session | 需要配合 `pi.sendMessage()`（需在扩展环境中） |
| 实时 UI 更新 | `ui.setWidget()` + 定时刷新 |
| 状态管理 | `Map<id, AgentState>` |
| 生命周期 | `spawn` → 处理事件 → `close` 事件 → 更新状态 |

---

## 总结

1. **进程隔离**：每个 subagent 是独立进程，通过 session 文件保持状态
2. **事件驱动**：JSON 模式输出是事件流，需要逐行解析
3. **session 复用**：`--session` 参数是实现多轮对话的关键
4. **结果汇总**：通过 `sendMessage()` 将结果注入主会话
5. **RPC 补充**：如需持久化进程和精确控制，考虑使用 RPC 模式
