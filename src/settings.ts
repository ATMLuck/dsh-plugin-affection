import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { describe } from './emotion.ts'
import type { Profile, Rules } from './emotion.ts'

const form = z.object({
  enabled: z.boolean(),
  persona: z.string(),
  tools: z.array(z.string().min(1)),
  revision: z.number().int().nonnegative(),
}).strict()
export type ChatSettings = z.infer<typeof form>
export const settingsDomain = defineDomain({
  name: 'dsh_affection_settings', version: 1, tables: { presets: domainTable<string, ChatSettings>(form) },
})

interface SettingsTable {
  get(id: string): ChatSettings | undefined
  put(id: string, value: ChatSettings): Promise<void>
}

export class SettingsProblem extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export class PresetSettings {
  private ctx: Context
  private table: SettingsTable
  private profile: (id: string) => Profile | undefined
  private rules: Rules
  private closed = false
  private writes = Promise.resolve()
  constructor(ctx: Context, table: SettingsTable, profile: (id: string) => Profile | undefined, rules: Rules) {
    this.ctx = ctx
    this.table = table
    this.profile = profile
    this.rules = rules
  }
  get(id: string): ChatSettings {
    return this.table.get(id) ?? { enabled: false, persona: '', tools: [], revision: 0 }
  }
  async roster() {
    return (await this.ctx.agentPresets.list()).map(({id, name, broken}) =>
      ({id, name: name || id, broken, enabled: this.get(id).enabled}))
  }
  async detail(id: string) {
    const preset = (await this.ctx.agentPresets.list()).find(p => p.id === id)
    if (!preset) throw new SettingsProblem(404, '这个预设已移除。')
    let tools: string[] = []
    if (!preset.broken) {
      const scope = await this.ctx.agentPresets.acquireScope(id)
      try { tools = this.ctx.tools.definitions(scope.key).map(t => t.name).sort() }
      finally { await scope[Symbol.asyncDispose]() }
    }
    const state = this.profile(id)
    const values = state ? { affection: state.affection, ...describe(state, Date.now(), this.rules).values } : null
    return { settings: this.get(id), tools, values, broken: preset.broken }
  }
  save(id: string, input: unknown) {
    if (this.closed) throw new SettingsProblem(503, '插件正在卸载。')
    const job = this.writes.then(async () => {
      const result = form.safeParse(input)
      if (!result.success) throw new SettingsProblem(400, '设置格式无效。')
      const value = result.data
      const detail = await this.detail(id)
      if (value.revision !== detail.settings.revision) throw new SettingsProblem(409, '设置已在其他窗口更新。草稿已保留，请重新载入后编辑。')
      if (value.enabled && !value.persona.trim()) throw new SettingsProblem(400, '启用前请填写人格提示词。')
      if (value.enabled && detail.broken) throw new SettingsProblem(400, detail.broken)
      if (value.tools.some(name => !detail.tools.includes(name) && !detail.settings.tools.includes(name)))
        throw new SettingsProblem(400, '工具列表已变化，请重新检查。')
      const next = { ...value, tools: [...new Set(value.tools)], revision: value.revision + 1 }
      await this.table.put(id, next)
      return next
    })
    this.writes = job.then(() => {}, () => {})
    return job
  }
  close() {
    this.closed = true
    return this.writes
  }
}

// The shared Fetch carrier admits authenticated owner peers on Web and desktop.
interface FetchCarrier {
  fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'
    fetch(request: Request): Promise<Response> }): () => Promise<void> }
}
export function serveSettings(ctx: Context, settings: PresetSettings) {
  ctx.inject(['connection'], scoped => {
    const carrier = scoped.get('connection') as FetchCarrier
    scoped.effect(() => carrier.fetch.register({
      path: '/api/affection/settings', methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        const id = new URL(request.url).searchParams.get('preset')
        const headers = { 'cache-control': 'no-store' }
        try {
          if (request.method === 'GET')
            return Response.json(id ? await settings.detail(id) : await settings.roster(), { headers })
          if (!id || !request.headers.get('content-type')?.startsWith('application/json'))
            throw new SettingsProblem(400, '请选择预设并提交 JSON 设置。')
          let input: unknown
          try { input = await request.json() } catch { throw new SettingsProblem(400, '设置格式无效。') }
          return Response.json(await settings.save(id, input), { headers })
        } catch (error) {
          const problem = error instanceof SettingsProblem ? error : new SettingsProblem(500, '读取或保存角色设置失败。')
          return Response.json({ error: problem.message }, { status: problem.status, headers })
        }
      },
    }))
  })
}
