import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { commands, makeProfile } from './emotion.ts'
import type { Command, Route } from './emotion.ts'
import { modelAnalyzer } from './analysis.ts'
import { affectionDomain, Config } from './schema.ts'
import { Role } from './role.ts'

export { Config }
export const name = 'affection'
export const inject = ['agents', 'agentPresets', 'systemPrompt', 'llm', 'commands', 'storageDomain']

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

export async function apply(ctx: Context, config: Config) {
  if (!config.enabledPresets.length) return
  const domain = await ctx.storageDomain.open(affectionDomain)
  const table = domain.table('roles')
  const roles = new Map<string, Role>()
  const views = new WeakMap<Agent, TurnView>()
  const fibers = new Map<Agent, Fiber>()
  const bindings = new Map<Agent, Promise<void>>()
  const analyze = modelAnalyzer(ctx, config)
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined

  function forAgent(agent: Agent): Role | undefined {
    if (closed || agent.session.header.origin === 'subagent') return
    const id = ctx.agentPresets.presetForSession(agent.session)
    if (id) return roles.get(id)
  }

  ctx.effect(() => async () => {
    closed = true
    clearInterval(timer)
    const stopping = Array.from(roles.values(), role => role.close())
    await Promise.allSettled([...stopping, ...bindings.values()])
    await Promise.allSettled(Array.from(fibers.values(), f => f.dispose()))
    await domain.close()
  })
  for (const id of new Set(config.enabledPresets)) {
    if (!table.get(id)) await table.put(id, makeProfile(config, config.fullAffectionPresets.includes(id), Date.now()))
    roles.set(id, new Role(id, table, config, analyze, message => ctx.logger.warn(message)))
  }

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
    const role = forAgent(agent)
    if (!role || decision.kind !== 'enter' || signal.aborted) return decision
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

  // Agent-scoped registrations follow preset changes and both plugin lifetimes.
  function syncCommands(agent: Agent) {
    const previous = bindings.get(agent) ?? Promise.resolve()
    const job = previous.then(async () => {
      if (closed) return
      const old = fibers.get(agent)
      if (ctx.agents.get(agent.id) !== agent || !forAgent(agent)) {
        fibers.delete(agent)
        if (old) await old.dispose()
      } else if (!old) {
        const fiber = agent.ctx.plugin({ name: 'affection-commands', inject: ['commands'], apply(scoped: Context) {
          for (const command of Object.keys(commands) as Command[]) {
            scoped.commands.register({
              name: command, description: commands[command],
              async handler({ agent: target, rawInput }) {
                const role = forAgent(target)
                if (!role) return { kind: 'error', text: '当前角色未启用情感插件。' }
                try {
                  return { kind: 'success', text: await role.command(command, rawInput) }
                } catch (error) {
                  return { kind: 'error', text: error instanceof Error ? error.message : '情绪命令执行失败。' }
                }
              },
            })
          }
        } })
        fibers.set(agent, fiber)
        await fiber.inertia
      }
    })
    bindings.set(agent, job)
    void job.finally(() => { if (bindings.get(agent) === job) bindings.delete(agent) })
      .catch(() => ctx.logger.warn('角色命令注册失败。'))
    return job
  }
  ctx.on('agent/created', async ({ agent }) => { await syncCommands(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => { fibers.delete(agent); views.delete(agent) })
  ctx.on('agent-preset/selected', id => { const agent = ctx.agents.get(id); if (agent) void syncCommands(agent) })
  await Promise.all(ctx.agents.list().map(syncCommands))

  if (config.idleEnabled) timer = setInterval(() => {
    for (const role of roles.values()) void role.idle().catch(() => ctx.logger.warn('空闲状态检查失败。'))
  }, 60000)
}
