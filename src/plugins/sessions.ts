import { type Context, Service } from '@deepseek-ai/cordis'
import {
    type ChatMessage,
    type Session,
    type SessionEvent,
    type SessionEventType,
    type SessionMeta,
    SessionStore,
} from '../core/session.ts'

/**
 * D2：把 `SessionStore` 包成 cordis Service。
 *
 * 这是 seam 三段式里的 Provider/适配层：core 里是纯逻辑，插件层负责把它挂到
 * `ctx.sessions`，让 loop / cli 等 Consumer 只认服务名、不认实现。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 追加式会话事件日志。 */
        sessions: SessionsService
    }
}

/** `ctx.sessions` 的实现：薄薄一层代理到 `SessionStore`。 */
export class SessionsService extends Service {
    /** 底层注册表；Provider（E1 JSONL）与测试可以直接读事件。 */
    readonly store = new SessionStore()

    constructor(ctx: Context) {
        super(ctx, 'sessions')
    }

    create(meta: { title?: string } = {}): Session {
        return this.store.create(meta)
    }

    get(id: string): Session | undefined {
        return this.store.get(id)
    }

    require(id: string): Session {
        return this.store.require(id)
    }

    list(): SessionMeta[] {
        return this.store.list()
    }

    delete(id: string): boolean {
        return this.store.delete(id)
    }

    clear(id: string): void {
        this.store.clear(id)
    }

    append(id: string, type: SessionEventType, data: unknown): SessionEvent {
        return this.store.append(id, type, data)
    }

    deriveMessages(id: string): ChatMessage[] {
        return this.store.deriveMessages(id)
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-sessions'

/** 挂载 `ctx.sessions`；卸载时 Service 随 fiber 一起消失。 */
export function apply(ctx: Context): void {
    ctx.plugin(SessionsService)
}
