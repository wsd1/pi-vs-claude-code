# 两种 SubAgent 结果合并方式对比

在 Pi 扩展中，主 Agent 派发 SubAgent 独立进程执行任务后，需要将结果合并回主 Agent 的对话上下文。目前主流有两种实现方式，各有优劣。

## 方式一：Tool Result（工具返回值）

**代表实现**：`agent-team-comment.ts`

### 核心流程

主 Agent 调用 `dispatch_agent` 工具 → 启动 SubAgent 子进程 → SubAgent 执行完成 → **通过工具的返回值返回结果**。

```typescript
// SubAgent 执行完成后，resolve 结果
resolve({
    output: full,           // SubAgent 的完整输出文本
    exitCode: code ?? 1,    // 退出码
    elapsed: state.elapsed, // 耗时
});

// 工具层封装为 tool_result 返回给主 Agent
return {
    content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
    details: { fullOutput: result.output, ... },
};
```

### 特点

**简单直接**：结果作为工具调用返回值进入对话，上下文天然包含这条消息。

**显式控制**：主 Agent 明确知道这是工具结果，需要主动读取和处理。

**信息损失**：只返回文本输出，SubAgent 的思考过程、工具调用记录等元数据丢失。

---

## 方式二：sendMessage + CustomType（自定义消息）

**代表实现**：`subagent-widget-comment.ts`

### 核心流程

主 Agent 调用 `subagent_create` 工具 → 启动 SubAgent 子进程（后台运行）→ SubAgent 执行完成 → **通过 `sendMessage` 发送自定义类型消息**。

```typescript
// SubAgent 执行完成后，发送自定义消息
pi.sendMessage({
    customType: "subagent-result",
    content: `Subagent #${state.id} finished "${prompt}"...\n\nResult:\n${result}`,
    display: true,
}, { deliverAs: "followUp", triggerTurn: true });
```

### 特点

**结构化数据**：可携带丰富的 metadata（如 agent ID、轮次、exitCode、耗时）。

**语义清晰**：`customType` 明确标识消息来源，区别于普通用户消息和工具返回值。

**自动触发**：`triggerTurn: true` 可让主 Agent 自动开始新一轮思考，无需显式处理。

---

## 对比总结

| 维度 | Tool Result | sendMessage + CustomType |
|------|-------------|-------------------------|
| **数据承载** | 文本为主 | 可带任意 metadata |
| **语义表达** | "工具完成了任务" | "收到子 Agent 的结果通知" |
| **主 Agent 感知** | 作为 tool_result 消息 | 作为自定义消息，可自动触发 |
| **灵活性** | 固定格式 | 自定义结构 |
| **适用场景** | 确定性流程、层级调度 | 复杂协作、需要自动流转 |

---

## 改进空间：结合两者优点

两种方式并非互斥，可以设计一种**增强型方案**，兼顾灵活性和可控性：

### 方案设计

```typescript
// 工具返回值 + 自定义元数据
return {
    content: [{ type: "text", text: resultSummary }],
    metadata: {
        customType: "subagent-result",
        fromAgent: "scout",
        exitCode: 0,
        elapsed: 1500,
        // 建议下一步动作，引导主 Agent 自动处理
        suggestedNext: {
            tool: "dispatch_agent",
            params: { agent: "builder", task: `基于分析结果实现...` }
        }
    }
};
```

### 核心改进点

1. **保留 tool result 语义**：不改变基本调用模型。

2. **扩展 metadata**：携带结构化元数据，便于前端渲染和日志分析。

3. **添加 suggestedNext**：在系统提示中引导主 Agent："当收到带 `suggestedNext` 的结果时，自动 dispatch 下一个 Agent"。

这样既保留了 Tool Result 的可控性，又获得了 sendMessage 的灵活性，尤其适合多 Agent 流水线场景（如 Scout → Builder → Tester）。
