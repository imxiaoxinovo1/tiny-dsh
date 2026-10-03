import { type Context, Service } from '@deepseek-ai/cordis'
import type { ApprovalPolicy } from '../core/permission-preset.ts'
import {
    DEFAULT_PRESETS,
    derivePreset,
    type PermissionPreset,
    presetTable,
    resolvePreset,
    validatePresetTable,
} from '../core/permission-preset.ts'
import type { SandboxMode } from '../core/tool.ts'
import type { ApprovalService } from './approval.ts'
import type { SandboxService } from './sandbox.ts'

/**
 * E3：把两个执行旋钮（sandbox 模式 + 审批策略）捆成具名预设。
 *
 * 两个旋钮仍然是唯一的执行权威；预设只是它们的一张命名表 + 一个写路径。
 * 单独改任一旋钮后，只要不再匹配任何预设，`current()` 就降级为 `custom`。
 */

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 权限预设表。 */
        permissionPresets: PermissionPresetsService
    }
}

/** 配置。 */
export interface PermissionPresetsConfig {
    /** 覆盖默认预设表。 */
    presets?: PermissionPreset[]
    /** 启动时应用的预设名。 */
    defaultPreset?: string
}

export class PermissionPresetsService extends Service {
    private readonly presets: Record<string, PermissionPreset>
    private selection: string | undefined
    private readonly sandboxService: SandboxService
    private readonly approvalService: ApprovalService

    constructor(ctx: Context, config: PermissionPresetsConfig = {}) {
        super(ctx, 'permissionPresets')
        this.sandboxService = ctx.sandbox
        this.approvalService = ctx.approval
        this.presets = presetTable(config.presets ?? DEFAULT_PRESETS)
        validatePresetTable(this.presets)

        if (config.defaultPreset) this.select(config.defaultPreset)
    }

    /** 可选的预设表。 */
    list(): PermissionPreset[] {
        return Object.values(this.presets)
    }

    /**
     * 当前生效的预设名。
     *
     * 仍然匹配的上次选择优先（两个预设共享同一 bundle 时用它区分），
     * 否则回退到「第一个匹配的预设」，再不行才是派生的 `custom`。
     */
    current(): string {
        if (this.selection) {
            const preset = this.presets[this.selection]
            if (
                preset &&
                preset.sandbox === this.sandboxService.mode &&
                preset.approval === this.approvalService.policy
            ) {
                return this.selection
            }
        }
        return derivePreset(this.sandboxService.mode, this.approvalService.policy, this.presets)
    }

    /** 解析预设；未知名字抛可读错误。 */
    resolve(name: string): PermissionPreset {
        return resolvePreset(name, this.presets)
    }

    /** 切换预设：分别写两个旋钮。 */
    select(name: string): void {
        const preset = this.resolve(name)
        this.sandboxService.setMode(preset.sandbox)
        this.approvalService.setPolicy(preset.approval)
        this.selection = preset.name
    }

    /** 单独改 sandbox 模式（当前预设随之可能降级）。 */
    setMode(mode: SandboxMode): void {
        this.sandboxService.setMode(mode)
    }

    /** 单独改审批策略（当前预设随之可能降级）。 */
    setPolicy(policy: ApprovalPolicy): void {
        this.approvalService.setPolicy(policy)
    }
}

/** cordis 插件显示名。 */
export const name = 'tiny-permission-presets'

/** 两个旋钮提供者都必须在。 */
export const inject = ['sandbox', 'approval']

/** 挂载 `ctx.permissionPresets`。 */
export function apply(ctx: Context, config: PermissionPresetsConfig = {}): void {
    // 先在 apply 里校验：配置错误会让本 fiber 直接 FAILED，await 得到可读错误。
    validatePresetTable(presetTable(config.presets ?? DEFAULT_PRESETS))
    ctx.plugin(PermissionPresetsService, config)
}
