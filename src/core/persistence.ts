import type { SessionEvent, SessionHeader, SessionMeta } from './session.ts'

/**
 * E1：JSONL 会话文件的编解码。纯逻辑，不 import cordis，也不碰磁盘。
 *
 * 文件形态：
 *   第 1 行  SessionHeader（type/version/id/createdAt/title）
 *   第 2..n 行  会话事件（seq/type/data/at）
 *
 * 解析必须**容忍崩溃留下的半行**：任何一行 JSON.parse 失败、或形状不对，
 * 都只丢这一行并计入 `skipped`，绝不让整份文件加载失败。
 */

/** 当前会话文件格式版本。 */
export const SESSION_FORMAT_VERSION = 1

/** JSONL 首行记录的形状。 */
export interface SessionFileHeader {
    type: 'session'
    version: number
    id: string
    createdAt: string
    title?: string
}

/** 解码结果。 */
export interface DecodedSessionFile {
    header: SessionFileHeader
    events: SessionEvent[]
    /** 被跳过的损坏行数（半行、非法 JSON、形状不符）。 */
    skipped: number
}

/** 把会话 header 编码成首行。 */
export function encodeHeader(header: SessionHeader): string {
    const record: SessionFileHeader = {
        type: 'session',
        version: SESSION_FORMAT_VERSION,
        id: header.id,
        createdAt: header.createdAt,
    }
    if (header.title) record.title = header.title
    return `${JSON.stringify(record)}\n`
}

/** 把一个事件编码成一行。 */
export function encodeEvent(event: SessionEvent): string {
    return `${JSON.stringify(event)}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function toEvent(value: Record<string, unknown>): SessionEvent | undefined {
    if (typeof value.type !== 'string') return undefined
    if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return undefined
    if (typeof value.at !== 'string') return undefined
    return {
        seq: value.seq,
        type: value.type,
        data: value.data ?? null,
        at: value.at,
    }
}

/**
 * 解析一份 JSONL 会话文件。
 *
 * @returns 解出的 header + 事件；连首行 header 都缺失/损坏时返回 `undefined`
 * （调用方应跳过该文件，而不是让加载失败）。
 */
export function decodeSessionFile(text: string): DecodedSessionFile | undefined {
    let header: SessionFileHeader | undefined
    const events: SessionEvent[] = []
    let skipped = 0

    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue

        let value: unknown
        try {
            value = JSON.parse(line)
        } catch {
            // 崩溃留下的半行会走到这里：丢这一行，继续。
            skipped += 1
            continue
        }
        if (!isRecord(value)) {
            skipped += 1
            continue
        }

        if (value.type === 'session' && header === undefined) {
            if (typeof value.id === 'string' && typeof value.createdAt === 'string') {
                header = {
                    type: 'session',
                    version:
                        typeof value.version === 'number' ? value.version : SESSION_FORMAT_VERSION,
                    id: value.id,
                    createdAt: value.createdAt,
                }
                if (typeof value.title === 'string') header.title = value.title
                continue
            }
            skipped += 1
            continue
        }

        const event = toEvent(value)
        if (event) events.push(event)
        else skipped += 1
    }

    return header ? { header, events, skipped } : undefined
}

/** 从解码结果生成列表用的元数据。 */
export function toSessionMeta(decoded: DecodedSessionFile): SessionMeta {
    const meta: SessionMeta = {
        id: decoded.header.id,
        createdAt: decoded.header.createdAt,
        eventCount: decoded.events.length,
    }
    if (decoded.header.title) meta.title = decoded.header.title
    return meta
}
