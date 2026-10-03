import type { SandboxMode } from './tool.ts'

/**
 * E3：把 sandbox 模式与审批策略捆成具名预设。纯逻辑，不 import cordis。
 *
 * 两个独立的执行旋钮：
 *   - sandbox 模式：read-only / workspace-write / danger-full-access
 *   - 审批策略：ask / never
 *
 * `never` 的语义与 DSH 一致：**不询问任何人，直接拒绝**。所以
 * `danger-full-access` = full-access + never 并不是「审批全部放行」——
 * 放行来自 sandbox 模式本身（工具在 full-access 下不再触发审批）。
 *
 * 两个旋钮任何一个被单独改动，只要不再匹配任何预设，当前预设就降级为派生的
 * `custom`（`custom` 不可作为切换目标）。
 */

/** 审批策略：ask = 交给回答者；never = 不询问，直接拒绝。 */
export type ApprovalPolicy = 'ask' | 'never'

/** 派生出来的「无匹配」标签；不是可配置预设。 */
export const CUSTOM_PRESET = 'custom'

/** 保留名：不能作为可配置预设。 */
export const RESERVED_PRESET_NAMES = [CUSTOM_PRESET, 'auto'] as const

/** 一个具名预设：名字 + 两个旋钮。 */
export interface PermissionPreset {
    name: string
    sandbox: SandboxMode
    approval: ApprovalPolicy
    /** 给 CLI 看的一句话说明。 */
    description?: string
}

/** DSH 默认表：只发这两个。 */
export const DEFAULT_PRESETS: readonly PermissionPreset[] = [
    {
        name: 'workspace-write',
        sandbox: 'workspace-write',
        approval: 'ask',
        description: 'Read and write inside the workspace; ask before writes.',
    },
    {
        name: 'danger-full-access',
        sandbox: 'danger-full-access',
        approval: 'never',
        description: 'No workspace confinement, no approval prompts.',
    },
]

/** 校验预设名没有占用保留字（custom / auto）。 */
export function validatePresetTable(table: Record<string, PermissionPreset>): void {
    for (const name of Object.keys(table)) {
        if ((RESERVED_PRESET_NAMES as readonly string[]).includes(name)) {
            throw new Error(`permission preset name "${name}" is reserved`)
        }
    }
}

/** 把预设数组变成 name → preset 的表。 */
export function presetTable(
    presets: readonly PermissionPreset[] = DEFAULT_PRESETS,
): Record<string, PermissionPreset> {
    const table: Record<string, PermissionPreset> = {}
    for (const preset of presets) table[preset.name] = preset
    return table
}

/** 从两个旋钮派生当前预设名：第一个匹配的预设，否则 `custom`。 */
export function derivePreset(
    sandbox: SandboxMode,
    approval: ApprovalPolicy,
    table: Record<string, PermissionPreset> = presetTable(),
): string {
    for (const preset of Object.values(table)) {
        if (preset.sandbox === sandbox && preset.approval === approval) return preset.name
    }
    return CUSTOM_PRESET
}

/** 解析预设名；`custom` 与未知名字都抛可读错误。 */
export function resolvePreset(
    name: string,
    table: Record<string, PermissionPreset> = presetTable(),
): PermissionPreset {
    if (name === CUSTOM_PRESET) {
        throw new Error('custom is derived-only and cannot be selected')
    }
    const preset = table[name]
    if (!preset) throw new Error(`unknown permission preset: "${name}"`)
    return preset
}
