import Schema from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { defaults } from './emotion.ts'
import type { Profile, Route, Rules } from './emotion.ts'

export interface Config extends Rules {
  enabledPresets: string[]
  fullAffectionPresets: string[]
  analysisRoute?: Route
  idleEnabled: boolean
  idleHours: number
  analysisTimeoutMs: number
}

const driveSetting = () => Schema.number().min(0).max(50).default(25)
export const Config: Schema<Config> = Schema.object({
  enabledPresets: Schema.array(Schema.string().min(1)).default([]).hidden(),
  fullAffectionPresets: Schema.array(Schema.string().min(1)).default([]),
  initialAffection: Schema.number().min(0).max(100).default(defaults.initialAffection),
  initialDrives: Schema.object({
    libidoOther: driveSetting(), aggressionOther: driveSetting(),
    libidoSelf: driveSetting(), aggressionSelf: driveSetting(),
  }).default(defaults.initialDrives),
  sensitivity: Schema.number().min(0).max(100).default(defaults.sensitivity),
  lockTurns: Schema.natural().min(1).default(defaults.lockTurns),
  decayHours: Schema.number().min(0.001).default(defaults.decayHours),
  idleEnabled: Schema.boolean().default(true),
  idleHours: Schema.number().min(0.001).default(6),
  analysisTimeoutMs: Schema.natural().min(1).max(2147483647).default(30000),
  analysisRoute: Schema.union([Schema.object({
    provider: Schema.string().min(1).required(), model: Schema.string().min(1).required(),
  })]),
})

const drive = z.number().min(0).max(50)
const count = z.number().int().nonnegative()
const axis = z.object({ base: drive, start: drive, since: count })
const progress = z.object({ turn: count, prompt: z.string() })
const record: z.ZodType<Profile> = z.object({
  affection: z.number().min(0).max(100),
  axes: z.object({ libidoOther: axis, aggressionOther: axis, libidoSelf: axis, aggressionSelf: axis }),
  turns: count, epoch: count, lastInteraction: count.nullable(), idleChecked: z.boolean(),
  route: z.object({ provider: z.string(), model: z.string() }).nullable(),
  lock: progress.nullable(), sessions: z.record(z.string(), progress),
})
export const affectionDomain = defineDomain({
  name: 'dsh_affection', version: 1, tables: { roles: domainTable<string, Profile>(record) },
})
