import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { makeProfile } from './emotion.ts'
import type { Route } from './emotion.ts'
import { modelAnalyzer } from './analysis.ts'
import { affectionDomain, Config } from './schema.ts'
import { Role } from './role.ts'

import { PresetSettings, serveSettings, settingsDomain } from './settings.ts'
import { bindChat, newChatState, type ChatState } from './chat.ts'

export { Config }
export const name = 'affection'
export const inject = ['agents', 'agentPresets', 'systemPrompt', 'llm', 'storageDomain', 'tools']

function textOf(message: Pick<UserMessage, 'content'>): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}
function historyBefore(session: Session, first: UserMessage) {
  const history = session.deriveMessages()
  const start = history.findLastIndex(message => message.id === first.id)
  const rows: string[] = []
  let remaining = 2000
  for (let i = start - 1; i >= 0 && remaining > 0; i--) {
    const message = history[i]
    let row: string
    if (message.role === 'user' && message.source.kind === 'user') {
      row = '用户：' + textOf(message)
    } else if (message.role === 'assistant') {
      row = '角色：' + textOf(message)
    } else continue
    rows.unshift(row.slice(-remaining))
    remaining -= row.length + 1
  }
  return rows.join('\n')
}

interface TurnView { turn: number; role: Role; prompt: string; route: Route; signal: AbortSignal; admitted: boolean; batch?: string[] }

// The host keeps a session's mode across plugin config reloads.
const sessionModes = new WeakMap<Agent, {preset: string; mode: ChatState | null}>()

export async function apply(ctx: Context, config: Config) {
  const domain = await ctx.storageDomain.open(affectionDomain)
  const table = domain.table('roles')
  const preferences = await ctx.storageDomain.open(settingsDomain).catch(async error => {
    await domain.close()
    throw error
  })
  const roles = new Map<string, Role>()
  const views = new WeakMap<Agent, TurnView>()
  const fibers = new Map<Agent, Fiber>()
  const analyze = modelAnalyzer(ctx, config)
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const initializing = new Map<string, Promise<Role>>()
  async function loadRole(id: string) {
    const existing = roles.get(id)
    if (existing) return existing
    const pending = initializing.get(id)
    if (pending) return pending
    const job = (async () => {
      if (!table.get(id)) await table.put(id, makeProfile(config, config.fullAffectionPresets.includes(id), Date.now()))
      const role = new Role(id, table, config, analyze, message => ctx.logger.warn(message))
      roles.set(id, role)
      return role
    })()
    initializing.set(id, job)
    try { return await job } finally { initializing.delete(id) }
  }
  const settings = new PresetSettings(ctx, preferences.table('presets'), id => table.get(id), config, loadRole)
  serveSettings(ctx, settings)
  function selection(agent: Agent) {
    const preset = ctx.agentPresets.presetForSession(agent.session)
    if (!preset || agent.session.header.origin === 'subagent') return
    let choice = sessionModes.get(agent)
    if (choice?.preset !== preset) {
      const saved = settings.get(preset)
      choice = { preset, mode: saved.enabled ? newChatState(saved) : null }
      sessionModes.set(agent, choice)
    }
    return choice
  }
  function forAgent(agent: Agent): Role | undefined {
    if (closed || agent.session.header.origin === 'subagent') return
    const selected = selection(agent)
    return selected?.mode ? roles.get(selected.preset) : undefined
  }

  ctx.effect(() => async () => {
    closed = true
    clearInterval(timer)
    await Promise.allSettled([...initializing.values(), settings.close()])
    const stopping = Array.from(roles.values(), role => role.close())
    await Promise.allSettled(stopping)
    await Promise.allSettled(Array.from(fibers.values(), f => f.dispose()))
    await Promise.all([domain.close(), preferences.close()])
  })
  await settings.restorePresets()
  // Resume idle evaluation for enabled, previously created profiles after restart.
  for (const id of table.keys()) if (settings.get(id).enabled) await loadRole(id)

  // Context providers are synchronous. Pin the text before admission refresh and
  // keep it for retries and later tool steps of this exact turn.
  ctx.systemPrompt.context({ name: 'affection:state', order: 250, required: true, interpolate: false,
    text: ({ agent }) => {
      if (!agent) return ''
      const view = views.get(agent)
      return view && view.role === forAgent(agent) ? view.prompt : ''
    } })
  ctx.on('agent/pre-step', async ({ agent, turn, modelSelection, signal }, next) => {
    const decision = await next()
    const selected = selection(agent)
    if (closed || !selected?.mode || decision.kind !== 'enter' || signal.aborted) return decision
    if (!decision.messages.some(message => message.source.kind === 'user') && !roles.has(selected.preset)) return decision
    const role = await loadRole(selected.preset)
    if (signal.aborted || closed) return decision
    const previous = views.get(agent)
    if (previous?.turn === turn && previous.role === role) return decision
    if (decision.messages.some(msg => msg.source.kind === 'user') || role.hasTurn(agent.session.id, turn)) {
      const prompt = await role.preview(agent.session.id, turn)
      views.set(agent, { role, turn, prompt, signal, admitted: false,
        route: { provider: modelSelection.provider, model: modelSelection.model } })
    }
    return decision
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' && event.type !== 'turn/start') return
    const agent = ctx.agents.get(session.id)
    if (!agent) return
    if (event.type === 'turn/start') {
      views.delete(agent)
      return
    }
    const view = views.get(agent)
    if (!view || event.data.source.kind !== 'user' || view.role !== forAgent(agent)) return
    if (view.admitted) {
      view.batch?.push(textOf(event.data))
      return
    }
    view.admitted = true
    // The host commits a batch of real inputs synchronously. Collect only the
    // admitted batch, excluding runtime context and subsequent tool steps.
    const lines = [textOf(event.data)]
    view.batch = lines
    queueMicrotask(() => {
      if (closed || view.role !== forAgent(agent)) return
      delete view.batch
      void view.role.admit(session.id, view.turn, view.route, {
        latest: lines.join('\n'), history: historyBefore(session, event.data),
      }, view.prompt, view.signal).catch(() => ctx.logger.warn('情绪档案写入失败。'))
    })
  })

  // A blank session may change preset right up to the first turn. Bind the
  // executor at turn/start, synchronously before the host resolves tool schemas.
  async function mountAgent(agent: Agent) {
    if (closed || agent.session.header.origin === 'subagent' || fibers.has(agent)) return
    const fiber = agent.ctx.plugin({ name: 'affection-chat', inject: ['systemPrompt', 'tools'], apply(scoped: Context) {
      let attached = false
      function attach(firstTurn?: number) {
        const chosen = selection(agent)
        if (closed || attached || !chosen?.mode) return
        attached = true
        bindChat(scoped, agent, () => settings.get(chosen.preset), chosen.mode, firstTurn)
      }
      selection(agent)
      if (ctx.agents.turnBoundaryOf(agent.session).lastTurn > 0) attach()
      scoped.on('session/event', (session, event) => {
        if (!attached && session === agent.session && event.type === 'turn/start') attach(event.data.turn)
      })
    } })
    fibers.set(agent, fiber)
    await fiber.inertia
  }
  ctx.on('agent/created', async ({ agent }) => { await mountAgent(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => { fibers.delete(agent); views.delete(agent) })
  ctx.on('agent-preset/selected', id => {
    const agent = ctx.agents.get(id)
    if (agent) selection(agent)
  })
  await Promise.all(ctx.agents.list().map(mountAgent))

  if (config.idleEnabled) timer = setInterval(() => {
    for (const role of roles.values()) if (settings.get(role.id).enabled) void role.idle().catch(() => ctx.logger.warn('空闲状态检查失败。'))
  }, 60000)
}
