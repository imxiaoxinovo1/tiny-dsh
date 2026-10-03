import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * D7：workspace 路径闸门。纯逻辑，不 import cordis。
 *
 * 两道防线：
 *   1. **词法**：拒绝绝对路径，拒绝 `../` 逃逸（resolve 后必须仍在 root 内）。
 *   2. **物理**：对最深的已存在祖先做 `realpath`，拒绝指向 root 之外的软链，
 *      即使软链本身位于 workspace 内部。
 */

/** 路径闸门错误。 */
export class PathGateError extends Error {
    name = 'PathGateError'
}

/** 读还是写；写模式用于错误信息与 read-only 判断。 */
export type PathIntent = 'read' | 'write'

export interface PathGateOptions {
    /** 是否允许绝对路径；默认拒绝。 */
    allowAbsolute?: boolean
}

/** `target` 是否等于 `root` 或位于 `root` 内（按路径段判断，避免 /a/bc 命中 /a/b）。 */
export function isInside(root: string, target: string): boolean {
    if (target === root) return true
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    return target.startsWith(prefix)
}

/** 找到 target 自身或它最深的已存在祖先。 */
async function deepestExisting(target: string): Promise<string> {
    let current = target
    while (true) {
        try {
            await fs.lstat(current)
            return current
        } catch {
            const parent = path.dirname(current)
            if (parent === current) return current
            current = parent
        }
    }
}

/** workspace 路径闸门。 */
export class PathGate {
    /** workspace 的 realpath，所有校验都以它为准。 */
    readonly root: string
    readonly #allowAbsolute: boolean

    constructor(root: string, options: PathGateOptions = {}) {
        this.root = root
        this.#allowAbsolute = options.allowAbsolute ?? false
    }

    /** 打开一个 workspace；`workspace` 自身也会被 realpath。 */
    static async open(workspace: string, options: PathGateOptions = {}): Promise<PathGate> {
        return new PathGate(await fs.realpath(path.resolve(workspace)), options)
    }

    /**
     * 解析并校验一个 workspace 内路径。
     *
     * @returns 可以安全读写的绝对路径。
     * @throws {PathGateError} 绝对路径、越界、软链逃逸、非法输入。
     */
    async resolve(input: string, intent: PathIntent = 'read'): Promise<string> {
        if (typeof input !== 'string' || input.length === 0) {
            throw new PathGateError('path is required')
        }
        if (input.includes('\0')) {
            throw new PathGateError(`cannot ${intent} "${input}": path contains a NUL byte`)
        }
        if (path.isAbsolute(input) && !this.#allowAbsolute) {
            throw new PathGateError(`cannot ${intent} "${input}": absolute paths are not allowed`)
        }

        const candidate = path.resolve(this.root, input)
        if (!isInside(this.root, candidate)) {
            throw new PathGateError(`cannot ${intent} "${input}": path escapes the workspace`)
        }

        // 物理校验：解析最近的存在祖先，软链必须仍然落在 root 内。
        const existing = await deepestExisting(candidate)
        const real = await fs.realpath(existing)
        if (!isInside(this.root, real)) {
            throw new PathGateError(
                `cannot ${intent} "${input}": path escapes the workspace through a symlink`,
            )
        }
        return path.join(real, path.relative(existing, candidate))
    }
}
