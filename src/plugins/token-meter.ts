import { type Context, Service } from '@deepseek-ai/cordis'
import type { ChatMessage } from '../core/message.ts'
import { estimateMessages, estimateRequest, estimateTokens } from '../core/token.ts'
import type { ToolSchema } from '../core/tool.ts'

/**
 * E2：把 token 估算包成 `ctx.tokenMeter`。纯函数，没有状态。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** token 估算。 */
        tokenMeter: TokenMeterService
    }
}

export class TokenMeterService extends Service {
    constructor(ctx: Context) {
        super(ctx, 'tokenMeter')
    }

    count(text: string): number {
        return estimateTokens(text)
    }

    countMessages(messages: readonly ChatMessage[]): number {
        return estimateMessages(messages)
    }

    countRequest(request: {
        system?: string
        messages: readonly ChatMessage[]
        tools?: readonly ToolSchema[]
    }): number {
        return estimateRequest(request)
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-token-meter'

/** 挂载 `ctx.tokenMeter`。 */
export function apply(ctx: Context): void {
    ctx.plugin(TokenMeterService)
}
