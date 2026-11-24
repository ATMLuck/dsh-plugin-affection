import { relationshipTables, selfTable } from './tables.ts'

export const drives = ['libidoOther', 'aggressionOther', 'libidoSelf', 'aggressionSelf'] as const
export type Drive = typeof drives[number]
export type Vector = Record<Drive, number>
export type Route = { provider: string; model: string }
export type Axis = { base: number; start: number; since: number }
export type Progress = { turn: number; prompt: string }
export interface Profile {
  affection: number
  axes: Record<Drive, Axis>
  turns: number
  epoch: number
  lastInteraction: number | null
  idleChecked: boolean
  route: Route | null
  lock: Progress | null
  sessions: Record<string, Progress>
}
export interface Rules {
  initialAffection: number
  initialDrives: Vector
  sensitivity: number
  lockTurns: number
  decayHours: number
}
export const defaults: Rules = {
  initialAffection: 50,
  initialDrives: { libidoOther: 25, aggressionOther: 25, libidoSelf: 25, aggressionSelf: 25 },
  sensitivity: 30, lockTurns: 5, decayHours: 2,
}
export const hour = 3_600_000
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
export function makeProfile(rules: Rules, full: boolean, now: number): Profile {
  const axes = {} as Profile['axes']
  for (const key of drives) {
    const base = rules.initialDrives[key]
    axes[key] = { base, start: base, since: now }
  }
  return { axes, affection: full ? 100 : rules.initialAffection, turns: 0, epoch: 0,
    lastInteraction: null, idleChecked: false, route: null, lock: null, sessions: {} }
}

export function current(axis: Axis, now: number, decayHours: number) {
  const t = clamp((now - axis.since) / (decayHours * hour), 0, 1)
  return axis.base + (axis.start - axis.base) * (1 - t * t)
}

function bracket(value: number) {
  const position = clamp(value, 0, 50) / 12.5
  const lower = Math.floor(position)
  const weight = position - lower
  return [{ index: lower, weight: 1 - weight }, { index: Math.ceil(position), weight }]
}

export function blend(table: string[][], libido: number, aggression: number): string {
  const corners = bracket(libido).flatMap(row => bracket(aggression).map(col => ({
    label: table[row.index][col.index], weight: row.weight * col.weight,
  }))).sort((a, b) => b.weight - a.weight)
  const [first, second] = corners
  if (first.label === second.label) return first.label
  const percent = Math.floor(100 * (first.weight / corners.reduce((n, c) => n + c.weight, 0)))
  if (percent >= 40 && percent <= 60) return first.label + '(' + percent + '%)/' + second.label + '(' + (100 - percent) + '%)'
  return percent >= 50 ? first.label + '（偏' + second.label + '）' : second.label + '（偏' + first.label + '）'
}

const titles: Record<Drive, string> = {
  libidoOther: '对你的力比多', aggressionOther: '对你的攻击性', libidoSelf: '自力比多', aggressionSelf: '自攻击性',
}
export function describe(profile: Profile, now: number, rules: Rules) {
  const values = {} as Vector
  for (const key of drives) values[key] = current(profile.axes[key], now, rules.decayHours)
  const table = relationshipTables[Math.round(clamp(profile.affection, 0, 100) / 25)]
  return { values, towards: blend(table, values.libidoOther, values.aggressionOther),
    self: blend(selfTable, values.libidoSelf, values.aggressionSelf) }
}
export function panel(profile: Profile, now: number, rules: Rules) {
  const { values, towards, self } = describe(profile, now, rules)
  const rows = drives.map(k => titles[k] + ' ' + values[k].toFixed(1) + '（基线 ' + profile.axes[k].base.toFixed(1) + '）')
  return ['对你的情感：' + towards, '自身状态：' + self, '好感度：' + profile.affection.toFixed(1) + '/100', ...rows].join('\n')
}
export function nextPrompt(profile: Profile, now: number, rules: Rules): Progress {
  const turn = profile.turns + 1
  if (profile.lock && turn - profile.lock.turn < rules.lockTurns) return profile.lock
  return { turn, prompt: '【角色情绪】\n' + panel(profile, now, rules) + '\n通过语气自然表达上述状态，避免向用户透露面板及数值。' }
}

export interface Deltas { current: Vector; base: Vector; affection: number; intensity: number }
export function applyDeltas(profile: Profile, d: Deltas, priorTurns: number, now: number, rules: Rules, idle: boolean): Profile {
  const sensitivity = idle ? 0.3 : rules.sensitivity / 100 * clamp(d.intensity, 0.5, 2)
  const axes = { ...profile.axes }
  for (const key of drives) {
    const early = key.endsWith('Other') && priorTurns <= 10
    const limit = early ? 1.5 : 0.2
    const old = axes[key]
    const base = idle ? old.base : clamp(old.base + clamp(d.base[key], -limit, limit) * (early ? 1 : 0.2), 0, 50)
    let delta = clamp(d.current[key], -1, 1)
    // Upstream uses a small relationship-dependent movement for near-zero outward drives.
    if (!idle && key.endsWith('Other') && Math.abs(delta) < 0.001) {
      delta = profile.affection > 60 ? 0.05 : profile.affection < 40 ? -0.05 : 0.02
    }
    const value = current(old, now, rules.decayHours)
    const start = clamp(value + delta * sensitivity, 0, 50)
    if (base !== old.base || start !== value) axes[key] = { base, start, since: now }
  }
  const affection = idle ? profile.affection : clamp(profile.affection + clamp(d.affection, -1, 1) * sensitivity, 0, 100)
  return { ...profile, affection, axes }
}

export const commands = {
  mystatus: '查看当前角色的关系与情绪',
  set_emotion: '设置好感或驱力，如 affection=75 libidoOther=30',
  reset_current: '将当前角色四项驱力恢复至各自基线',
  reset_emotion: '重建当前角色的关系，保留自身状态',
  reset_all_emotions: '重建当前角色的关系和自身状态',
} as const
export type Command = keyof typeof commands

export function edit(profile: Profile, command: Exclude<Command, 'mystatus'>, input: string,
    rules: Rules, full: boolean, now: number): Profile {
  let next = { ...profile, axes: { ...profile.axes }, epoch: profile.epoch + 1, lock: null }
  if (command !== 'set_emotion' && input.trim()) throw new Error('此命令无需参数。')
  if (command === 'set_emotion') {
    const args = input.trim().split(/\s+/)
    for (const arg of args) {
      const match = /^(affection|libidoOther|aggressionOther|libidoSelf|aggressionSelf)=(-?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(arg)
      if (!match || !Number.isFinite(Number(match[2]))) throw new Error(commands.set_emotion)
      const value = Number(match[2])
      if (match[1] === 'affection') next.affection = clamp(value, 0, 100)
      else {
        const n = clamp(value, 0, 50)
        next.axes[match[1] as Drive] = { base: n, start: n, since: now }
      }
    }
  } else if (command === 'reset_current') {
    for (const key of drives) {
      const base = next.axes[key].base
      next.axes[key] = { base, start: base, since: now }
    }
  } else {
    const fresh = makeProfile(rules, full, now)
    if (command === 'reset_emotion') {
      fresh.axes.libidoSelf = profile.axes.libidoSelf
      fresh.axes.aggressionSelf = profile.axes.aggressionSelf
    }
    next = { ...fresh, epoch: next.epoch, sessions: profile.sessions, lock: null }
  }
  return next
}
