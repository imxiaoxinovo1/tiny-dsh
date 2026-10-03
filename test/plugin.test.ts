import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as hello from '../src/plugins/hello.ts'
import { HelloService } from '../src/plugins/hello.ts'

// D1 验收：Context / Plugin / Service / ctx.effect() / disposer。
// 每个用例新建一个 Context，互不共享服务命名空间。

test('ctx.plugin() 挂载插件，Service 注册为 ctx.hello', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(hello, { greeting: '你好' })
    await fiber

    assert.ok(ctx.hello instanceof HelloService)
    assert.equal(ctx.hello.greeting, '你好')
    assert.equal(ctx.hello.greet('世界'), '你好, 世界!')
    assert.equal(ctx.hello.greet('cordis'), '你好, cordis!')
    assert.equal(ctx.hello.state.greetings, 2)
    assert.equal(ctx.hello.state.ready, true)
    assert.equal(ctx.hello.state.disposed, false)

    await fiber.dispose()
})

test('卸载插件后它注册的 Service 消失，effect disposer 与监听器一并撤销', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(hello)
    await fiber

    const service = ctx.hello
    ctx.emit('hello/greet', 'before')
    assert.equal(service.state.greetings, 1)

    await fiber.dispose()

    assert.equal(service.state.disposed, true)
    assert.equal(ctx.get('hello'), undefined)
    assert.equal(ctx.hello, undefined)

    // 监听器属于已卸载的 fiber，事件不应再触达旧实例。
    ctx.emit('hello/greet', 'after')
    assert.equal(service.state.greetings, 1)
})

test('ctx.effect() 的 setup 立即执行，disposer 卸载时按注册逆序执行', async () => {
    const ctx = new Context()
    const order: string[] = []

    const fiber = ctx.plugin({
        name: 'effect-order',
        apply(ctx: Context) {
            ctx.effect(() => {
                order.push('a:setup')
                return () => {
                    order.push('a:dispose')
                }
            }, 'a')
            ctx.effect(() => {
                order.push('b:setup')
                return () => {
                    order.push('b:dispose')
                }
            }, 'b')
        },
    })
    await fiber
    assert.deepEqual(order, ['a:setup', 'b:setup'])

    await fiber.dispose()
    assert.deepEqual(order, ['a:setup', 'b:setup', 'b:dispose', 'a:dispose'])
})

test('inject 声明依赖：Provider 缺席时插件保持 PENDING，不加载', async () => {
    const ctx = new Context()
    const log: string[] = []

    const consumer = ctx.plugin({
        name: 'consumer',
        inject: ['hello'],
        apply(ctx: Context) {
            log.push(`loaded ${ctx.hello.greeting}`)
        },
    })
    await consumer
    assert.deepEqual(log, [])

    // Provider 出现后，依赖条件满足，consumer 自动加载。
    const provider = ctx.plugin(hello)
    await provider
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(log, ['loaded Hello'])

    // Provider 卸载后，依赖条件消失，consumer 随之卸载并在 Provider 回来时重启。
    await provider.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await consumer.dispose()
    assert.deepEqual(log, ['loaded Hello'])
})

test('缺少 inject 声明就读服务时，报错可读', async () => {
    const ctx = new Context()
    const provider = ctx.plugin(hello)
    await provider

    await assert.rejects(async () => {
        await ctx.plugin({
            name: 'careless',
            apply(ctx: Context) {
                ctx.hello.greet('world')
            },
        })
    }, /cannot get property "hello" without inject/)

    await provider.dispose()
})
