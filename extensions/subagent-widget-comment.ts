/**
 * Subagent Widget — 背景子Agent系统，支撑 /sub, /subclear, /subrm, /subcont 命令
 * 
 * 核心机制 — 持久化会话:
 * 每个子Agent关联一个 JSONL 会话文件 (路径: ~/.pi/agent/sessions/subagents/subagent-{id}-{timestamp}.jsonl)
 * 首次创建时通过 --session 参数传递给子 Pi 进程，后续 /subcont 复用同一文件，从而保留完整对话历史。
 * 这使得主Agent可以持续指挥同一子Agent进行多轮任务，而无需重复上下文。
 * 
 * 核心机制 — 实时Widget:
 * 通过 pi.ui.setWidget() 为每个子Agent注册动态组件，渲染状态(运行中/完成/错误)、任务摘要、轮次、
 * 耗时、工具调用次数及最后一行输出。Widget随子Agent状态变化实时刷新(每1000ms更新耗时，每收到消息更新内容)。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
const { spawn } = require("child_process") as any;
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyExtensionDefaults } from "./themeMap.ts";

/** 子Agent运行时状态 */
interface SubState {
	id: number;
	status: "running" | "done" | "error";
	task: string;
	textChunks: string[];     // 流式输出的文本片段拼接
	toolCount: number;        // 累计工具调用次数
	elapsed: number;          // 运行时长(ms)
	sessionFile: string;      // 持久化会话文件路径 — /subcont 复用此文件续话
	turnCount: number;        // /subcont 调用次数+1，用于显示"第N轮"
	proc?: any;               // ChildProcess 引用，运行中可被 kill
}

export default function (pi: ExtensionAPI) {
	const agents: Map<number, SubState> = new Map();
	let nextId = 1;
	let widgetCtx: any;

	// ── Session file helpers ──────────────────────────────────────────────────

	/** 在 ~/.pi/agent/sessions/subagents/ 目录下创建唯一的会话文件路径 */
	function makeSessionFile(id: number): string {
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
	}

	// ── Widget rendering ──────────────────────────────────────────────────────

	/** 遍历所有子Agent，为每个注册或更新一个动态Widget — 显示状态图标、任务摘要、耗时、工具数、最新输出行 */
	function updateWidgets() {
		if (!widgetCtx) return;

		for (const [id, state] of Array.from(agents.entries())) {
			const key = `sub-${id}`;
			widgetCtx.ui.setWidget(key, (_tui: any, theme: any) => {
				const container = new Container();
				const borderFn = (s: string) => theme.fg("dim", s);

				container.addChild(new Text("", 0, 0)); // top margin
				container.addChild(new DynamicBorder(borderFn));
				const content = new Text("", 1, 0);
				container.addChild(content);
				container.addChild(new DynamicBorder(borderFn));

				return {
					render(width: number): string[] {
						const lines: string[] = [];
						// 根据状态映射颜色和图标
						const statusColor = state.status === "running" ? "accent"
							: state.status === "done" ? "success" : "error";
						const statusIcon = state.status === "running" ? "●"
							: state.status === "done" ? "✓" : "✗";

						// 任务文本过长则截断
						const taskPreview = state.task.length > 40
							? state.task.slice(0, 37) + "..."
							: state.task;

						// 仅在非首轮时显示"Turn N"
						const turnLabel = state.turnCount > 1
							? theme.fg("dim", ` · Turn ${state.turnCount}`)
							: "";

						// 第一行：状态图标 + ID + 轮次 + 任务摘要 + 耗时 + 工具数
						lines.push(
							theme.fg(statusColor, `${statusIcon} Subagent #${state.id}`) +
							turnLabel +
							theme.fg("dim", `  ${taskPreview}`) +
							theme.fg("dim", `  (${Math.round(state.elapsed / 1000)}s)`) +
							theme.fg("dim", ` | Tools: ${state.toolCount}`)
						);

						// 第二行：最新非空输出行（截断至合适宽度）
						const fullText = state.textChunks.join("");
						const lastLine = fullText.split("\n").filter((l: string) => l.trim()).pop() || "";
						if (lastLine) {
							const trimmed = lastLine.length > width - 10
								? lastLine.slice(0, width - 13) + "..."
								: lastLine;
							lines.push(theme.fg("muted", `  ${trimmed}`));
						}

						content.setText(lines.join("\n"));
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
				};
			});
		}
	}

	// ── Streaming helpers ─────────────────────────────────────────────────────

	/** 解析子Pi进程的JSON模式输出行，提取消息更新与工具执行事件 */
	function processLine(state: SubState, line: string) {
		if (!line.trim()) return;
		try {
			const event = JSON.parse(line);
			const type = event.type;

			// message_update.assistantMessageEvent.type === "text_delta" 表示流式文本
			if (type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") {
					state.textChunks.push(delta.delta || "");
					updateWidgets();
				}
			} else if (type === "tool_execution_start") {
				state.toolCount++;
				updateWidgets();
			}
		} catch {}
	}

	/** 
	 * 启动子Pi进程执行任务 
	 * 关键参数: --session {sessionFile} 使会话历史持久化，供后续 /subcont 复用
	 * --mode json -p 以JSON行格式输出事件流，便于解析
	 */
	function spawnAgent(
		state: SubState,
		prompt: string,
		ctx: any,
	): Promise<void> {
		// 优先使用当前模型的完整provider/id，否则回退到默认模型
		const model = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";

		return new Promise<void>((resolve) => {
			const proc = spawn("pi", [
				"--mode", "json",
				"-p",
				"--session", state.sessionFile,   // 持久化会话 — /subcont 通过同一文件续话
				"--no-extensions",
				"--model", model,
				"--tools", "read,bash,grep,find,ls",
				"--thinking", "off",
				prompt,
			], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			state.proc = proc;

			// 每秒更新一次耗时
			const startTime = Date.now();
			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidgets();
			}, 1000);

			let buffer = "";

			// 解析stdout的JSON行流
			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";  // 保留未完整的一行
				for (const line of lines) processLine(state, line);
			});

			// stderr 直接追加为文本输出
			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				if (chunk.trim()) {
					state.textChunks.push(chunk);
					updateWidgets();
				}
			});

			// 进程结束时更新状态、发送通知和结果消息
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(state, buffer);
				clearInterval(timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";
				state.proc = undefined;
				updateWidgets();

				const result = state.textChunks.join("");
				ctx.ui.notify(
					`Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				// 通过 customType 发送结果，triggerTurn让主对话可继续
				pi.sendMessage({
					customType: "subagent-result",
					content: `Subagent #${state.id}${state.turnCount > 1 ? ` (Turn ${state.turnCount})` : ""} finished "${prompt}" in ${Math.round(state.elapsed / 1000)}s.\n\nResult:\n${result.slice(0, 8000)}${result.length > 8000 ? "\n\n... [truncated]" : ""}`,
					display: true,
				}, { deliverAs: "followUp", triggerTurn: true });

				resolve();
			});

			proc.on("error", (err) => {
				clearInterval(timer);
				state.status = "error";
				state.proc = undefined;
				state.textChunks.push(`Error: ${err.message}`);
				updateWidgets();
				resolve();
			});
		});
	}

		// ── Tools for the Main Agent ──────────────────────────────────────────────

	/** 工具: 立即返回子Agent ID，后台异步执行任务 — fire-and-forget模式 */
	pi.registerTool({
		name: "subagent_create",
		description: "Spawn a background subagent to perform a task. Returns the subagent ID immediately while it runs in the background. Results will be delivered as a follow-up message when finished.",
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for the subagent to perform" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task: args.task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),  // 每个子Agent独立的会话文件
				turnCount: 1,
			};
			agents.set(id, state);
			updateWidgets();

			// Fire-and-forget: 不等待spawnAgent完成
			spawnAgent(state, args.task, ctx);

			return {
				content: [{ type: "text", text: `Subagent #${id} spawned and running in background.` }],
			};
		},
	});

	/** 工具: 继续已有子Agent的会话 — 复用其sessionFile */
	pi.registerTool({
		name: "subagent_continue",
		description: "Continue an existing subagent's conversation. Use this to give further instructions to a finished subagent. Returns immediately while it runs in the background.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to continue" }),
			prompt: Type.String({ description: "The follow-up prompt or new instructions" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
			}
			if (state.status === "running") {
				return { content: [{ type: "text", text: `Error: Subagent #${args.id} is still running.` }] };
			}

			state.status = "running";
			state.task = args.prompt;
			state.textChunks = [];      // 清空旧输出，开始新一轮
			state.elapsed = 0;
			state.turnCount++;           // 轮次+1
			updateWidgets();

			ctx.ui.notify(`Continuing Subagent #${args.id} (Turn ${state.turnCount})…`, "info");
			spawnAgent(state, args.prompt, ctx);  // sessionFile 已被复用

			return {
				content: [{ type: "text", text: `Subagent #${args.id} continuing conversation in background.` }],
			};
		},
	});

	/** 工具: 移除指定子Agent，若运行中则Kill进程 */
	pi.registerTool({
		name: "subagent_remove",
		description: "Remove a specific subagent. Kills it if it's currently running.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to remove" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
			}

			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
			}
			ctx.ui.setWidget(`sub-${args.id}`, undefined);
			agents.delete(args.id);

			return {
				content: [{ type: "text", text: `Subagent #${args.id} removed successfully.` }],
			};
		},
	});

	/** 工具: 列出所有子Agent的ID、状态、轮次、任务 */
	pi.registerTool({
		name: "subagent_list",
		description: "List all active and finished subagents, showing their IDs, tasks, and status.",
		parameters: Type.Object({}),
		execute: async () => {
			if (agents.size === 0) {
				return { content: [{ type: "text", text: "No active subagents." }] };
			}

			const list = Array.from(agents.values()).map(s => 
				`#${s.id} [${s.status.toUpperCase()}] (Turn ${s.turnCount}) - ${s.task}`
			).join("\n");

			return {
				content: [{ type: "text", text: `Subagents:\n${list}` }],
			};
		},
	});



	// ── /sub <task> ───────────────────────────────────────────────────────────

	/** 命令: 快捷创建子Agent，底层调用相同的spawnAgent逻辑 */
	pi.registerCommand("sub", {
		description: "Spawn a subagent with live widget: /sub <task>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const task = args?.trim();
			if (!task) {
				ctx.ui.notify("Usage: /sub <task>", "error");
				return;
			}

			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
			};
			agents.set(id, state);
			updateWidgets();

			// Fire-and-forget
			spawnAgent(state, task, ctx);
		},
	});

	// ── /subcont <number> <prompt> ────────────────────────────────────────────

	/** 命令: 继续指定ID的子Agent — 解析参数后复用已有状态和sessionFile */
	pi.registerCommand("subcont", {
		description: "Continue an existing subagent's conversation: /subcont <number> <prompt>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const trimmed = args?.trim() ?? "";
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) {
				ctx.ui.notify("Usage: /subcont <number> <prompt>", "error");
				return;
			}

			const num = parseInt(trimmed.slice(0, spaceIdx), 10);
			const prompt = trimmed.slice(spaceIdx + 1).trim();

			if (isNaN(num) || !prompt) {
				ctx.ui.notify("Usage: /subcont <number> <prompt>", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found. Use /sub to create one.`, "error");
				return;
			}

			if (state.status === "running") {
				ctx.ui.notify(`Subagent #${num} is still running — wait for it to finish first.`, "warning");
				return;
			}

			// Resume: update state for a new turn
			state.status = "running";
			state.task = prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;
			updateWidgets();

			ctx.ui.notify(`Continuing Subagent #${num} (Turn ${state.turnCount})…`, "info");

			// Fire-and-forget — reuses the same sessionFile for conversation history
			spawnAgent(state, prompt, ctx);
		},
	});

	// ── /subrm <number> ───────────────────────────────────────────────────────

	/** 命令: 移除指定子Agent，若运行中则Kill */
	pi.registerCommand("subrm", {
		description: "Remove a specific subagent widget: /subrm <number>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const num = parseInt(args?.trim() ?? "", 10);
			if (isNaN(num)) {
				ctx.ui.notify("Usage: /subrm <number>", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found.`, "error");
				return;
			}

			// Kill the process if still running
			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
				ctx.ui.notify(`Subagent #${num} killed and removed.`, "warning");
			} else {
				ctx.ui.notify(`Subagent #${num} removed.`, "info");
			}

			ctx.ui.setWidget(`sub-${num}`, undefined);
			agents.delete(num);
		},
	});

	// ── /subclear ─────────────────────────────────────────────────────────────

	/** 命令: 清理所有子Agent — 遍历Kill所有运行中的进程，移除全部Widget，重置ID计数器 */
	pi.registerCommand("subclear", {
		description: "Clear all subagent widgets",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;

			let killed = 0;
			for (const [id, state] of Array.from(agents.entries())) {
				if (state.proc && state.status === "running") {
					state.proc.kill("SIGTERM");
					killed++;
				}
				ctx.ui.setWidget(`sub-${id}`, undefined);
			}

			const total = agents.size;
			agents.clear();
			nextId = 1;

			const msg = total === 0
				? "No subagents to clear."
				: `Cleared ${total} subagent${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
			ctx.ui.notify(msg, total === 0 ? "info" : "success");
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────────────────

	/** 会话开始时清理：Kill所有运行中的子Agent进程、移除Widget、清除内存状态
	 *  (避免子进程泄露至下一个主会话) */
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
			}
			ctx.ui.setWidget(`sub-${id}`, undefined);
		}
		agents.clear();
		nextId = 1;
		widgetCtx = ctx;
	});
}
