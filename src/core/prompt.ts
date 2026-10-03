/**
 * D6：System Prompt 组装。纯逻辑，不 import cordis。
 *
 * 两类片段共享同一个 order 空间：
 *   - `section`  静态文本或工厂
 *   - `context`  必须是工厂，表达「每次 assemble 都要重读」的 harness 状态
 *                 （当前时间、cwd、host 都是状态，不是模型知识）
 *
 * `assemble()` 每次都重新调用工厂，所以同一个 session 的每一步都会拿到新鲜值。
 */

/** 片段文本：静态字符串，或每次 assemble 都重新调用的工厂。 */
export type PromptText = string | (() => string | Promise<string>)

/** 命名 section。 */
export interface PromptSection {
    name: string
    /** 越小越靠前；相同 order 按注册顺序。缺省 0。 */
    order?: number
    text: PromptText
}

/** 命名 context：文本必须是工厂。 */
export interface PromptContext {
    name: string
    order?: number
    text: () => string | Promise<string>
}

/** 片段摘要，供 CLI / 调试查看。 */
export interface PromptEntryInfo {
    name: string
    order: number
    kind: 'section' | 'context'
}

interface Entry {
    definition: PromptSection
    kind: 'section' | 'context'
    seq: number
}

/** section / context 注册表。 */
export class SystemPromptRuntime {
    readonly #sections = new Map<string, Entry>()
    readonly #contexts = new Map<string, Entry>()
    #seq = 0

    /** 注册一个 section；返回幂等 disposer。同名 section 重复注册会报错。 */
    section(definition: PromptSection): () => void {
        return this.#register(this.#sections, definition, 'section')
    }

    /** 注册一个 context（文本必须是工厂）；返回幂等 disposer。 */
    context(definition: PromptContext): () => void {
        if (typeof definition?.text !== 'function') {
            throw new Error(`context "${definition?.name ?? ''}" text must be a factory function`)
        }
        return this.#register(this.#contexts, definition, 'context')
    }

    /** 按 order（同级按注册顺序）列出片段摘要。 */
    list(): PromptEntryInfo[] {
        return this.#sorted().map((entry) => ({
            name: entry.definition.name,
            order: entry.definition.order ?? 0,
            kind: entry.kind,
        }))
    }

    /** 组装 system prompt：按 order 拼接，空片段跳过。 */
    async assemble(): Promise<string> {
        const parts: string[] = []
        for (const entry of this.#sorted()) {
            const value =
                typeof entry.definition.text === 'function'
                    ? await entry.definition.text()
                    : entry.definition.text
            if (typeof value !== 'string') continue
            const text = value.trim()
            if (text) parts.push(text)
        }
        return parts.join('\n\n')
    }

    #sorted(): Entry[] {
        return [...this.#sections.values(), ...this.#contexts.values()].sort(
            (a, b) => (a.definition.order ?? 0) - (b.definition.order ?? 0) || a.seq - b.seq,
        )
    }

    #register(
        store: Map<string, Entry>,
        definition: PromptSection,
        kind: 'section' | 'context',
    ): () => void {
        if (!definition?.name) throw new Error(`${kind}.name is required`)
        if (definition.order !== undefined && !Number.isFinite(definition.order)) {
            throw new Error(`${kind} "${definition.name}" order must be a finite number`)
        }
        if (store.has(definition.name)) throw new Error(`duplicate ${kind}: ${definition.name}`)

        const entry: Entry = { definition, kind, seq: ++this.#seq }
        store.set(definition.name, entry)

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true
            if (store.get(definition.name) === entry) store.delete(definition.name)
        }
    }
}
