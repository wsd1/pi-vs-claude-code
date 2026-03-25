

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
    let timeoutId = 0;
	
    function now(): string{
        return new Date().toLocaleString("sv-SE").replace("T", " ");
    }

	pi.registerTool({
		name: "stop_waiting",
		label: "等候",
		description: "需要等候就调用。须说明等一段时间之后要做什么，可以设定等候时间",
		parameters: Type.Object({
            duration: Type.Optional(Type.Number({ description: "等候多少秒，不确定就不填" })),
			reason: Type.String({ description: "等候之后我要做什么", default: "继续当前任务...",}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			ctx.abort();

            if(params.duration && params.duration > 0){
                const waitms = params.duration * 1000;
                timeoutId = setTimeout(() => {
                    timeoutId = 0;
					pi.sendMessage({
							customType: "stop-waiting",
							content: `⏰当前时间：${now()}。已等候${params.duration}秒，之前我的计划是【${params.reason}】`,
							display: true,
						},
						{ triggerTurn: true }, // triggerTurn - get LLM to respond
					);
                }, waitms);                 
            }

			return {
				content: [{ type: "text", text: `⏰当前时间：${now()}。${(params.duration && params.duration > 0)?`等待${params.duration}秒`:"等会"}，我的计划是：${params.reason}` }],
			};
		},
	});
	return {
		dispose: () => {
			if (timeoutId > 0) clearTimeout(timeoutId);
		},
	};
}
