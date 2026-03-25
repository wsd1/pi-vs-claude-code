
# specialist插件设计说明

---
重点参考：
/home/wsd1/workshop/pi-vs-claude-code/extensions/subagent-widget.ts

部分参考：
/home/wsd1/workshop/pi-vs-claude-code/extensions/agent-team.ts

## 代码前端定义常量

```ts
//subAgent须加载的插件
const subExtensions = ["../pi-expansion/extensions/mqtt-monitor.ts", ....]
```

## function (pi: ExtensionAPI) 函数中必须包括的变量

### agentId

该变量从命令行参数获取。

插件须定义成语变量
```ts
	let agentId: string | undefined;
```

插件初始化时须：
```ts
	pi.registerFlag("agentid", {
		type: "string",
		description: "Agent name for MQTT topic (e.g., designer001, worker-1)",
		default: "unknown-agent",
	});
```

须定义成员函数：
```ts
	function getAgentId(): string {
		if (agentId === undefined) {
			const v = pi.getFlag("agentid");
			agentId = (v && v !== "") ? v : "errorAgentId";
		}
		return agentId;
	}
```


### shortSessionId

取自当前sessionId前8字符

须定义成员变量
```ts
	let shortSessionId: string | undefined;
```
该变量在初始化时，可能无法确定，只能通过内部更新的成员函数来获取。
```ts
	function getShortSessionId(): string {
		if (shortSessionId === undefined) {
			const v = ctx.sessionManager.getSessionId();
			shortSessionId = (v && v !== "") ? v.split('-')[0] : "errorSessionId";
		}
		return shortSessionId;
	}
```

### allAgentDefs
```ts
	let allAgentDefs: AgentDef[] = [];
```


## 初始化时需要扫描专家描述文件

subAgent请遵循以下的结构类型定义。

```ts
interface AgentDef {
	name: string;			//专家名称
	description: string;	//简要描述
	tools: string;			//搭配工具
	superPowers: string;	//可安装扩展
	systemPrompt: string;	//文件主体内容
	model: string;			//搭配模型
	file: string;			//文件路径名称
}
```

专家描述文件的扫描过程可以参考 agent-team.ts 中函数 function loadAgents(cwd: string) 。其中不用team的逻辑。


## tool定义：subagent 须指派任务、专家名称和工作路径 三个参数


```
	pi.registerTool({
		name: "subagent",
		description: "为某位专家部署后台任务，返回 ID。",
		parameters: Type.Object({
			task: Type.String({ description: "任务要求（必须填写。重点是说清楚目标，可以提供辅助材料，不必安排细节）" }),
			specialist: Type.Optional(Type.String({ description: "可以指定专家名称，不确定可以不填" })),
			workdir: Type.Optional(Type.String({ description: "subAgent的工作文件夹路径，没有需求可以不填" })),
		}),
```


## 实现makeSessionFile(id)函数
请借鉴 subagent-widget.ts中的实现。这里的命名规则应该改为 时间戳 + [主agent shortSessionId] + nextId索引号

譬如 "2026-03-10T12-11-18-639Z_8c272fde_sub-2.jsonl"。

可以参考：
```ts
	function makeSessionFile(id: number): string {
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		`${fileTimestamp}_${this.sessionId}.jsonl`
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `${fileTimestamp}_parent-${getShortSessionId()}_sub-${id}.jsonl`);
		//"2026-03-10T12-11-18-639Z_parent-8c272fde_sub-2.jsonl"
	}
```



## spawnAgent()中的几个细节


### 为subAgent显式提供 agentId , 工作路径 和 mqtt扩展路径

常量 const_mqtt_extension_path："../pi-expansion/extensions/mqtt-monitor.ts"，请定义在代码开端

```typescript
			const proc = spawn("pi", [
				"--mode", "json",
				"-p",
				"--session", state.sessionFile,   // 持久化会话 — 可以通过同一文件续话
				"--no-extensions",
                "-e", subExtensions[0],   //<------ 循环放置所有
                "-e", subExtensions[1],   //<------ 循环放置所有...
				"--model", model,	// <------- 如果 model未定义，就去掉该行
				"--tools", "read,bash,grep,find,ls",
				"--thinking", "off",
                "--agentId", current_agent_id       //<------agentId
				prompt,
			], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
                cwd: param_cwd,  // <------ 设定子进程工作目录
			});

```

## 向主agent发送subAgent的工作结果时，要带上 agentId

```typescript

pi.sendMessage({
	customType: "subagent-result",
	content: ...
	display: true,
    details: {
        agentId: current_agent_id   //<------agentId
    }
}, { deliverAs: "followUp", triggerTurn: true });

```

