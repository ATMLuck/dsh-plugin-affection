import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { describe } from './emotion.ts'
import type { Profile, Rules } from './emotion.ts'
import type { Role } from './role.ts'
import { randomUUID } from 'node:crypto'

const form = z.object({
  enabled: z.boolean(),
  persona: z.string(),
  tools: z.array(z.string().min(1)),
  revision: z.number().int().nonnegative(),
}).strict()
export type ChatSettings = z.infer<typeof form>
const storedForm = form.extend({ createdName: z.string().min(1).optional() })
type SavedSettings = z.infer<typeof storedForm>
export const settingsDomain = defineDomain({
  name: 'dsh_affection_settings', version: 1, tables: { presets: domainTable<string, SavedSettings>(storedForm) },
})

interface SettingsTable {
  get(id: string): SavedSettings | undefined
  put(id: string, value: SavedSettings): Promise<void>
  entries(): Iterable<[string, SavedSettings]>
}

const drive = z.number().min(0).max(50)
const emotionForm = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), epoch: z.number().int().nonnegative(), values: z.object({
    affection: z.number().min(0).max(100), libidoOther: drive, aggressionOther: drive, libidoSelf: drive, aggressionSelf: drive,
  }).partial().strict().refine(values => Object.keys(values).length > 0) }).strict(),
  z.object({ action: z.enum(['reset-current', 'reset-relationship', 'reset-all']), epoch: z.number().int().nonnegative() }).strict(),
])
const newPresetForm = z.object({ name: z.string().trim().min(1).max(80) }).strict()

export class SettingsProblem extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export class PresetSettings {
  private ctx: Context
  private table: SettingsTable
  private profile: (id: string) => Profile | undefined
  private rules: Rules
  private loadRole: (id: string) => Promise<Role>
  private created = new Map<string, () => Promise<void>>()
  private closed = false
  private writes = Promise.resolve()
  constructor(ctx: Context, table: SettingsTable, profile: (id: string) => Profile | undefined, rules: Rules,
    loadRole: (id: string) => Promise<Role>) {
    this.ctx = ctx
    this.table = table
    this.profile = profile
    this.rules = rules
    this.loadRole = loadRole
  }
  get(id: string): ChatSettings {
    const { enabled = false, persona = '', tools = [], revision = 0 } = this.table.get(id) ?? {}
    return { enabled, persona, tools, revision }
  }
  async restorePresets() {
    for (const [id, record] of this.table.entries()) {
      if (record.createdName) this.created.set(id, await this.ctx.agentPresets.register({
        id, name: record.createdName, plugins: [],
      }))
    }
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
    return { settings: this.get(id), tools, emotion: state ? this.emotion(state) : null, broken: preset.broken }
  }
  private emotion(state: Profile) {
    const { values, towards, self } = describe(state, Date.now(), this.rules)
    const { libidoOther, aggressionOther, libidoSelf, aggressionSelf } = state.axes
    return { values: { affection: state.affection, ...values }, baseline: {
      libidoOther: libidoOther.base, aggressionOther: aggressionOther.base,
      libidoSelf: libidoSelf.base, aggressionSelf: aggressionSelf.base,
    }, towards, self, turns: state.turns, epoch: state.epoch }
  }
  save(id: string, input: unknown) {
    return this.write(async () => {
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
      await this.table.put(id, { ...this.table.get(id), ...next })
      return next
    })
  }
  create(input: unknown) {
    return this.write(async () => {
      const result = newPresetForm.safeParse(input)
      if (!result.success) throw new SettingsProblem(400, '请输入 1 至 80 字符的预设名称。')
      const id = 'affection-' + randomUUID()
      const name = result.data.name
      const detach = await this.ctx.agentPresets.register({ id, name, plugins: [] })
      try {
        await this.table.put(id, { ...this.get(id), createdName: name })
      } catch (error) {
        await detach()
        throw error
      }
      this.created.set(id, detach)
      return { id, name, enabled: false }
    })
  }
  changeEmotion(id: string, input: unknown) {
    return this.write(async () => {
      const result = emotionForm.safeParse(input)
      if (!result.success) throw new SettingsProblem(400, '请检查数值范围。')
      if (!(await this.ctx.agentPresets.list()).some(preset => preset.id === id))
        throw new SettingsProblem(404, '这个预设已移除。')
      const { epoch, ...change } = result.data
      const role = await this.loadRole(id)
      const state = await role.change(change, epoch)
      if (!state) throw new SettingsProblem(409, '情感档案已被手动更新。请重新打开编辑开关。')
      return this.emotion(state)
    })
  }
  private write<T>(mutate: () => Promise<T>) {
    if (this.closed) throw new SettingsProblem(503, '插件正在卸载。')
    const job = this.writes.then(mutate)
    this.writes = job.then(() => {}, () => {})
    return job
  }
  async close() {
    this.closed = true
    await this.writes
    await Promise.allSettled([...this.created.values()].map(detach => detach()))
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
        const query = new URL(request.url).searchParams
        const id = query.get('preset')
        const headers = { 'cache-control': 'no-store' }
        try {
          if (request.method === 'GET')
            return Response.json(id ? await settings.detail(id) : await settings.roster(), { headers })
          if (!request.headers.get('content-type')?.startsWith('application/json'))
            throw new SettingsProblem(400, '请提交 JSON 设置。')
          let input: unknown
          try { input = await request.json() } catch { throw new SettingsProblem(400, '设置格式无效。') }
          if (!id && query.get('edit') === 'preset')
            return Response.json(await settings.create(input), { headers })
          if (!id) throw new SettingsProblem(400, '请选择预设。')
          const result = query.get('edit') === 'emotion' ? await settings.changeEmotion(id, input) : await settings.save(id, input)
          return Response.json(result, { headers })
        } catch (error) {
          const problem = error instanceof SettingsProblem ? error : new SettingsProblem(500, '读取或保存角色设置失败。')
          return Response.json({ error: problem.message }, { status: problem.status, headers })
        }
      },
    }))
  })
}
