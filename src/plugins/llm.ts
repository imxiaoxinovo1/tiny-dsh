import { type Context, Service } from '@deepseek-ai/cordis'
import {
    type LlmProvider,
    LlmRuntime,
    type ModelRequest,
    type ModelResponse,
    type RegisterOptions,
} from '../core/llm.ts'

/**
 * D4：把 `LlmRuntime` 包成 `ctx.llm`。
 *
 * 和 `ctx.tools.register()` 一样，`register()` 用 `this.ctx.effect()` 绑定到
 * **调用方** fiber：provider 插件卸载时它的 provider 自动注销。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** LLM Provider 注册表与路由。 */
        llm: LlmService
    }
}

/** `ctx.llm` 的实现：薄薄一层代理到 `LlmRuntime`。 */
export class LlmService extends Service {
    /** 底层注册表；Provider 插件直接注册到这里。 */
    readonly runtime = new LlmRuntime()

    constructor(ctx: Context) {
        super(ctx, 'llm')
    }

    register(provider: LlmProvider, options: RegisterOptions = {}): () => void {
        return this.ctx.effect(
            () => this.runtime.register(provider, options),
            `llm.register(${provider.name})`,
        )
    }

    get(name: string): LlmProvider | undefined {
        return this.runtime.get(name)
    }

    has(name: string): boolean {
        return this.runtime.has(name)
    }

    list(): LlmProvider[] {
        return this.runtime.list()
    }

    get defaultProvider(): string | undefined {
        return this.runtime.defaultProvider
    }

    resolve(model: string): { provider: LlmProvider; model: string } {
        return this.runtime.resolve(model)
    }

    complete(request: ModelRequest): Promise<ModelResponse> {
        return this.runtime.complete(request)
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-llm'

/** 挂载 `ctx.llm`。 */
export function apply(ctx: Context): void {
    ctx.plugin(LlmService)
}
