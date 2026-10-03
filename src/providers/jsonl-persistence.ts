import fs from 'node:fs/promises'
import path from 'node:path'
import {
    type DecodedSessionFile,
    decodeSessionFile,
    encodeEvent,
    encodeHeader,
    type SessionFileHeader,
    toSessionMeta,
} from '../core/persistence.ts'
import type { SessionEvent, SessionHeader, SessionMeta } from '../core/session.ts'

/**
 * E1：JSONL 持久化 provider。
 *
 * 每个会话一个文件：`<directory>/<id>.jsonl`，首行 header，之后一行一个事件。
 * 所有写操作走同一条 promise 队列串行化，保证行序；调用方通常 fire-and-forget，
 * 需要确定性时 `await provider.flush()`。
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file)
        return true
    } catch {
        return false
    }
}

export interface JsonlPersistenceOptions {
    /** 写失败回调；默认静默。 */
    onError?: (error: unknown) => void
}

export class JsonlPersistence {
    /** 会话目录（绝对路径）。 */
    readonly directory: string
    private readonly onError: (error: unknown) => void
    private ready: Promise<void> | undefined
    private queue: Promise<void> = Promise.resolve()

    constructor(directory: string, options: JsonlPersistenceOptions = {}) {
        this.directory = path.resolve(directory)
        this.onError = options.onError ?? (() => {})
    }

    /** 懒创建目录。 */
    init(): Promise<void> {
        this.ready ??= fs.mkdir(this.directory, { recursive: true }).then(() => undefined)
        return this.ready
    }

    /** 会话文件路径；id 非法直接抛（防目录穿越）。 */
    file(id: string): string {
        if (!SAFE_ID.test(id)) throw new Error(`invalid session id: "${id}"`)
        return path.join(this.directory, `${id}.jsonl`)
    }

    /** 写首行 header（文件已存在则不动）。 */
    saveHeader(header: SessionHeader): Promise<void> {
        return this.enqueue(async () => {
            await this.init()
            const file = this.file(header.id)
            if (await exists(file)) return
            await fs.writeFile(file, encodeHeader(header), 'utf8')
        })
    }

    /** 追加一个事件；文件不存在时先补 header。 */
    appendEvent(header: SessionHeader, event: SessionEvent): Promise<void> {
        return this.enqueue(async () => {
            await this.init()
            const file = this.file(header.id)
            if (!(await exists(file))) await fs.writeFile(file, encodeHeader(header), 'utf8')
            await fs.appendFile(file, encodeEvent(event), 'utf8')
        })
    }

    /** 等待队列里的写入全部落盘。 */
    async flush(): Promise<void> {
        await this.queue
    }

    /** 列出目录里的会话元数据（按 createdAt 排序，跳过损坏文件）。 */
    async list(): Promise<SessionMeta[]> {
        await this.init()
        await this.flush()
        const names = await fs.readdir(this.directory)
        const metas: SessionMeta[] = []
        for (const name of names) {
            if (!name.endsWith('.jsonl')) continue
            const decoded = await this.read(path.join(this.directory, name))
            if (decoded) metas.push(toSessionMeta(decoded))
        }
        return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }

    /** 读取一个会话（id 不存在或文件损坏时返回 undefined）。 */
    async resume(id: string): Promise<DecodedSessionFile | undefined> {
        const target = this.file(id)
        await this.init()
        await this.flush()
        return this.read(target)
    }

    /** 删除一个会话文件。 */
    async delete(id: string): Promise<boolean> {
        const target = this.file(id)
        await this.init()
        await this.flush()
        try {
            await fs.unlink(target)
            return true
        } catch {
            return false
        }
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        const next = this.queue.then(task, task).catch((error) => {
            this.onError(error)
        })
        this.queue = next
        return next
    }

    private async read(target: string): Promise<DecodedSessionFile | undefined> {
        try {
            return decodeSessionFile(await fs.readFile(target, 'utf8'))
        } catch {
            return undefined
        }
    }
}

/** 便于 CLI / 调试展示的重导出。 */
export type { SessionFileHeader }
