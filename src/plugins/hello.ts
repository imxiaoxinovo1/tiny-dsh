import { type Context, Service } from '@deepseek-ai/cordis'

/**
 * D1：cordis 骨架示范。
 *
 * 这个插件不碰任何 harness 逻辑，它只把 cordis 的五个概念放进一个最小例子：
 *
 *   Context   组合根 create 出来的依赖容器，插件只通过 ctx 拿能力
 *   Plugin    `apply(ctx, config)`，由 `ctx.plugin()` 挂载成一个 fiber
 *   Service   `HelloService` 通过 `super(ctx, 'hello')` 注册成 `ctx.hello`
 *   Effect    `ctx.effect()` 托管 cordis 不认识的生命周期资源
 *   Disposer  卸载时按注册逆序执行；`fiber.dispose()` 可从外部触发
 *
 * 注意：Service 注册、`ctx.on()` 监听本身就是 effect，不需要额外包 `ctx.effect()`。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** hello 插件提供的服务。 */
        hello: HelloService
    }

    interface Events {
        /** 请求打招呼；apply 里的监听器会把它转成 `HelloService.greet()`。 */
        'hello/greet'(who: string): void
    }
}

/** `hello` 插件的配置。 */
export interface HelloConfig {
    /** 招呼语前缀，默认 `Hello`。 */
    greeting?: string
}

/** 一次服务实例的生命周期快照。 */
export interface HelloState {
    /** `greet()` 累计调用次数。 */
    greetings: number
    /** `ctx.effect()` 的 setup 已执行。 */
    ready: boolean
    /** `ctx.effect()` 返回的 disposer 已执行。 */
    disposed: boolean
}

/**
 * D1 教学用 Service。
 *
 * 构造时执行 `super(ctx, 'hello')`，把实例注册到当前 fiber 上；fiber 卸载时
 * cordis 自动撤销注册，所以卸载后 `ctx.hello` 就消失了。
 */
export class HelloService extends Service {
    /** 构造时确定的招呼语前缀。 */
    readonly greeting: string
    /** 生命周期快照，测试与 CLI 都读它。 */
    readonly state: HelloState = { greetings: 0, ready: false, disposed: false }

    constructor(ctx: Context, config: HelloConfig = {}) {
        super(ctx, 'hello')
        this.greeting = config.greeting ?? 'Hello'
    }

    /** 生成一句招呼，调用次数会累加。 */
    greet(who: string): string {
        this.state.greetings += 1
        return `${this.greeting}, ${who}!`
    }
}

/** cordis 插件显示名，出现在 fiber 诊断与日志里。 */
export const name = 'hello'

/**
 * 把 `ctx.hello` 挂到当前 Context 上。
 *
 * 所有注册都依附于 `ctx.plugin(hello)` 返回的那个 fiber：卸载它，服务、
 * 事件监听、effect disposer 会一起撤销，核心链路不留残留。
 */
export function apply(ctx: Context, config: HelloConfig = {}): void {
    const service = new HelloService(ctx, config)

    // ctx.effect() 用于 cordis 管不到的资源（定时器、连接、文件句柄……）。
    // setup 在 apply 期间同步执行；disposer 在 fiber 卸载时执行，幂等。
    ctx.effect(() => {
        service.state.ready = true
        return () => {
            service.state.disposed = true
        }
    }, 'hello: lifetime')

    // ctx.on() 注册的监听器同样是 effect，卸载时自动移除。
    ctx.on('hello/greet', (who: string) => {
        ctx.logger('hello').info(service.greet(who))
    })
}
