import { type Context, Service } from '@deepseek-ai/cordis'
import {
    Session,
    type SessionMeta,
    type SessionObserver,
    type SessionStore,
} from '../core/session.ts'
import { JsonlPersistence } from '../providers/jsonl-persistence.ts'

/**
 * E1：把 JSONL provider 挂到 `ctx.persistence`，并订阅 `ctx.sessions` 的变化。
 *
 * 方向是「persistence 依赖 sessions」而不是反过来：卸载持久化后会话日志照常工作，
 * 只是不落盘（设计原则 4：能力可选）。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** JSONL 会话持久化。 */
        persistence: PersistenceService
    }
}

/** persistence 配置。 */
export interface PersistenceConfig {
    /** 会话目录；缺省相对进程 cwd 的 `sessions`。 */
    directory?: string
}

export class PersistenceService extends Service {
    readonly provider: JsonlPersistence
    // 不用 # 私有字段：Service 方法里的 this 是 tracing 影子代理。
    private sessionStore: SessionStore

    constructor(ctx: Context, config: PersistenceConfig = {}) {
        super(ctx, 'persistence')

        const store = ctx.sessions.store
        this.sessionStore = store
        this.provider = new JsonlPersistence(config.directory ?? 'sessions', {
            onError: (error) => ctx.logger.error(error),
        })

        const observer: SessionObserver = {
            create: (session) => {
                void this.provider.saveHeader(session)
            },
            append: (session, event) => {
                void this.provider.appendEvent(session, event)
            },
        }

        ctx.effect(() => {
            const detach = store.observe(observer)
            // 持久化可能晚于既有 session 创建：回填补写 header。
            void this.provider.flush().then(async () => {
                for (const session of store.all()) await this.provider.saveHeader(session)
            })
            return detach
        }, 'persistence: observe sessions')
    }

    /** 磁盘上的会话列表。 */
    list(): Promise<SessionMeta[]> {
        return this.provider.list()
    }

    /** 从磁盘恢复一个会话并放回 store。 */
    async resume(id: string): Promise<Session | undefined> {
        const decoded = await this.provider.resume(id)
        if (!decoded) return undefined
        return this.sessionStore.adopt(new Session(decoded.header, decoded.events))
    }

    /** 删除磁盘上的会话（同时从内存 store 删除）。 */
    async delete(id: string): Promise<boolean> {
        const removed = await this.provider.delete(id)
        this.sessionStore.delete(id)
        return removed
    }

    /** 等待排队中的写入落盘。 */
    flush(): Promise<void> {
        return this.provider.flush()
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-persistence'

/** 订阅 ctx.sessions；不存在时本插件保持 PENDING。 */
export const inject = ['sessions']

/** 挂载 `ctx.persistence`。 */
export function apply(ctx: Context, config: PersistenceConfig = {}): void {
    ctx.plugin(PersistenceService, config)
}
