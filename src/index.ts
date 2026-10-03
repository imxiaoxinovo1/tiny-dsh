import { Context } from '@deepseek-ai/cordis'
import * as hello from './plugins/hello.ts'

// 组合根：所有能力都通过 root.plugin() 挂载，模块之间不直接 import，
// 跨模块通信一律走 ctx.<service>（见 ARCHITECTURE.md 设计原则 1）。
// D1 只挂 hello 骨架插件；D2 起在这里按依赖顺序追加 sessions / tools / llm …
const root = new Context()

await root.plugin(hello)

console.log(`tiny-dsh: ${root.constructor.name} ready`)
console.log(`  ctx.hello.greet('world') -> ${root.hello.greet('world')}`)
