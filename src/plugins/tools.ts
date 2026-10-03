import { type Context, Service } from '@deepseek-ai/cordis'
import type { ToolCall } from '../core/message.ts'
import {
    type ToolDefinition,
    type ToolExecutionContext,
    ToolRegistry,
    type ToolResult,
    type ToolSchema,
} from '../core/tool.ts'

/**
 * D3：把 `ToolRegistry` 包成 `ctx.tools`。
 *
 * 关键点：`register()` 用 `this.ctx.effect()` 把 disposer 绑到**调用方** fiber
 * （cordis 的 tracing 会把服务方法里的 `this.ctx` 解析成调用方 ctx），所以注册工具
 * 的插件卸载时，它的工具自动注销；`ctx.tools` 本身则随 tools 插件 fiber 一起消失。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 工具注册表与执行流水线。 */
        tools: ToolsService
    }
}

/** `ctx.tools` 的实现：薄薄一层代理到 `ToolRegistry`。 */
export class ToolsService extends Service {
    /** 底层注册表；Provider（D7 的文件 / shell 工具）直接注册到这里。 */
    readonly registry = new ToolRegistry()

    constructor(ctx: Context) {
        super(ctx, 'tools')
    }

    /** 注册工具；disposer 同时受调用方与插件生命周期控制，且幂等。 */
    register(definition: ToolDefinition): () => void {
        return this.ctx.effect(
            () => this.registry.register(definition),
            `tools.register(${definition.name})`,
        )
    }

    get(name: string): ToolDefinition | undefined {
        return this.registry.get(name)
    }

    has(name: string): boolean {
        return this.registry.has(name)
    }

    list(): ToolDefinition[] {
        return this.registry.list()
    }

    schemas(): ToolSchema[] {
        return this.registry.schemas()
    }

    execute(call: ToolCall, context: ToolExecutionContext = {}): Promise<ToolResult> {
        return this.registry.execute(call, context)
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-tools'

/** 挂载 `ctx.tools`。 */
export function apply(ctx: Context): void {
    ctx.plugin(ToolsService)
}
