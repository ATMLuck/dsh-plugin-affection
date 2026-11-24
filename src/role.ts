import { applyDeltas, edit, hour, nextPrompt, panel } from './emotion.ts'
import type { Command, Profile, Progress, Route } from './emotion.ts'
import type { Analyze, Interaction } from './analysis.ts'
import type { Config } from './schema.ts'

export interface RoleStore { get(key: string): Profile | undefined; put(key: string, value: Profile): Promise<void> }

interface Ticket {
  epoch: number
  turns: number
  route: Route
  interaction?: Interaction
  signal?: AbortSignal
  lastInteraction: number
}

// Admission and commands share a short write queue. The slower model queue never holds it.
export class Role {
  readonly id: string
  private store: RoleStore
  private config: Config
  private analyze: Analyze
  private clock: () => number
  private report: (message: string) => void
  private stop = new AbortController()
  private writes: Promise<void> = Promise.resolve()
  private analyses: Promise<void> = Promise.resolve()

  constructor(id: string, store: RoleStore, config: Config, analyze: Analyze,
      report: (message: string) => void, clock = Date.now) {
    this.id = id
    this.store = store
    this.config = config
    this.analyze = analyze
    this.report = report
    this.clock = clock
  }
  private state(): Profile {
    const value = this.store.get(this.id)
    if (!value) throw new Error('角色档案不存在')
    return value
  }
  private write<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(() => {
      this.stop.signal.throwIfAborted()
      return work()
    })
    this.writes = result.then(() => {}, () => {})
    return result
  }
  async preview(session: string, turn: number): Promise<string> {
    await this.writes
    const state = this.state()
    const seen = state.sessions['s_' + session]
    if (seen?.turn === turn) return seen.prompt
    return nextPrompt(state, this.clock(), this.config).prompt
  }
  hasTurn(session: string, turn: number) {
    return this.state().sessions['s_' + session]?.turn === turn
  }
  async admit(session: string, turn: number, route: Route | undefined, material: Interaction, shown: string, signal?: AbortSignal) {
    const now = this.clock()
    const key = 's_' + session
    await this.write(async () => {
      const state = this.state()
      if ((state.sessions[key]?.turn ?? 0) >= turn) return
      const count = state.turns + 1
      const lock: Progress = state.lock && count - state.lock.turn < this.config.lockTurns
        ? state.lock
        : { turn: count, prompt: shown }
      const selected = this.config.analysisRoute ?? route ?? null
      const next: Profile = { ...state, turns: count, lastInteraction: now, idleChecked: false, route: route ?? null,
        sessions: { ...state.sessions, [key]: { turn, prompt: shown } }, lock }
      await this.store.put(this.id, next)
      if (count > 1 && selected) {
        this.schedule({ epoch: state.epoch, turns: count, lastInteraction: now, route: selected, interaction: material, signal })
      }
    })
  }
  async idle() {
    const due = (state: Profile, now: number) => this.config.idleEnabled && !state.idleChecked
      && state.lastInteraction !== null && now - state.lastInteraction >= this.config.idleHours * hour
    if (!due(this.state(), this.clock())) return
    await this.write(async () => {
      const state = this.state()
      const route = this.config.analysisRoute ?? state.route
      if (!due(state, this.clock()) || !route || state.lastInteraction === null) return
      await this.store.put(this.id, { ...state, idleChecked: true })
      this.schedule({ epoch: state.epoch, turns: state.turns, lastInteraction: state.lastInteraction, route })
    })
  }
  private valid(ticket: Ticket, state: Profile) {
    return state.epoch === ticket.epoch && (ticket.interaction !== undefined ||
      (state.turns === ticket.turns && state.lastInteraction === ticket.lastInteraction && state.idleChecked))
  }
  private schedule(ticket: Ticket) {
    this.analyses = this.analyses.then(async () => {
      const state = this.state()
      if (this.stop.signal.aborted || !this.valid(ticket, state)) return
      const signals = [this.stop.signal, AbortSignal.timeout(this.config.analysisTimeoutMs)]
      if (ticket.signal) signals.push(ticket.signal)
      const signal = AbortSignal.any(signals)
      signal.throwIfAborted()
      const priorTurns = ticket.interaction ? ticket.turns - 1 : ticket.turns
      const delta = await this.analyze({ profile: state, priorTurns, now: this.clock(), route: ticket.route,
        interaction: ticket.interaction }, signal)
      signal.throwIfAborted()
      await this.write(async () => {
        const latest = this.state()
        if (!signal.aborted && this.valid(ticket, latest)) {
          await this.store.put(this.id, applyDeltas(latest, delta, priorTurns, this.clock(), this.config, !ticket.interaction))
        }
      })
    }).catch(() => {
      if (!this.stop.signal.aborted) this.report('情绪分析未完成，已保留状态。')
    })
  }
  command(command: Command, input: string): Promise<string> {
    return this.write(async () => {
      const state = this.state()
      if (command === 'mystatus') {
        if (input.trim()) throw new Error('此命令无需参数。')
        return '【' + this.id + '】\n' + panel(state, this.clock(), this.config) + '\n有效互动轮数：' + state.turns
      }
      const next = edit(state, command, input, this.config, this.config.fullAffectionPresets.includes(this.id), this.clock())
      await this.store.put(this.id, next)
      return '已更新 ' + this.id + ' 的情绪档案。'
    })
  }
  async settle() {
    await this.writes
    await this.analyses
    await this.writes
  }
  async close() {
    this.stop.abort()
    await this.settle()
  }
}
