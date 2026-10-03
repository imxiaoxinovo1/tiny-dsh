import { type Context, Service } from '@deepseek-ai/cordis'
import type { ApprovalPolicy } from '../core/permission-preset.ts'
import type { ApprovalRequest } from '../core/tool.ts'

/**
 * D7：把审批抽象成 `ctx.approval`。
 *
 * **默认拒绝**：没有回答者时 `request()` 返回 `'deny'`，所以没有审批通道的
 * 写操作 / shell 会 fail closed，而不是放行。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 审批通道。 */
        approval: ApprovalService
    }
}

/** 回答者：返回 true 表示允许。 */
export type ApprovalAnswerer = (request: ApprovalRequest) => boolean | Promise<boolean>

export class ApprovalService extends Service {
    // 不用 # 私有字段：Service 方法里的 this 是 tracing 影子代理。
    private answerer: ApprovalAnswerer | undefined
    private answererToken = 0
    /** 当前策略；由 permission presets 通过 setPolicy 改写。 */
    policy: ApprovalPolicy = 'ask'

    constructor(ctx: Context) {
        super(ctx, 'approval')
    }

    /** 注册回答者；disposer 绑定到调用方 fiber，幂等。 */
    setAnswerer(answerer: ApprovalAnswerer): () => void {
        return this.ctx.effect(() => {
            // 用递增 token 而不是函数身份比较：函数值经 tracing 代理会被包成
            // 影子方法，`this.answerer === answerer` 恒为假，旧 disposer 会误清新答案者。
            const token = ++this.answererToken
            this.answerer = answerer
            return () => {
                if (this.answererToken === token) this.answerer = undefined
            }
        }, 'approval.setAnswerer()')
    }

    /** 切换策略；permission presets 的写路径。 */
    setPolicy(policy: ApprovalPolicy): void {
        this.policy = policy
    }

    /** 当前是否有审批通道。 */
    get hasAnswerer(): boolean {
        return this.answerer !== undefined
    }

    /**
     * 请求审批。
     *
     * - `never`：不询问任何人，直接拒绝（与 DSH 语义一致）；
     * - `ask`：交给回答者；没有回答者时 fail closed。
     */
    async request(request: ApprovalRequest): Promise<'allow' | 'deny'> {
        if (this.policy === 'never') return 'deny'
        if (!this.answerer) return 'deny'
        return (await this.answerer(request)) ? 'allow' : 'deny'
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-approval'

/** 挂载 `ctx.approval`。 */
export function apply(ctx: Context): void {
    ctx.plugin(ApprovalService)
}
