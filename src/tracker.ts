import { emptyData, emptySkillStats, type SkillStats, type UsageData } from "./types.js"
import type { Store } from "./store.js"

export interface SkillActivated {
  sessionID: string
  id: string
  text: string
}

export interface StepEnded {
  sessionID: string
  tokens: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export interface Tracker {
  handleSkillActivated(e: SkillActivated): Promise<void>
  handleStepEnded(e: StepEnded): Promise<void>
  reset(): Promise<void>
  data(): UsageData
}

export function createTracker(deps: {
  store: Store
  charsPerToken: number
  now?: () => Date
  onChange?: () => void
}): Promise<Tracker> {
  const { store, charsPerToken, now = () => new Date(), onChange } = deps

  return store.load().then((initial) => {
    let current: UsageData = initial
    // sessionID -> skill ids loaded in that session (never persisted).
    const sessions = new Map<string, Set<string>>()

    const statsFor = (id: string): SkillStats => {
      let stats = current.skills[id]
      if (!stats) {
        stats = emptySkillStats()
        current.skills[id] = stats
      }
      return stats
    }

    const flush = async (): Promise<void> => {
      await store.save(current)
      onChange?.()
    }

    return {
      handleSkillActivated: async (e: SkillActivated): Promise<void> => {
        const stats = statsFor(e.id)
        stats.loads += 1
        stats.contentTokens += Math.round(e.text.length / charsPerToken)
        stats.lastUsed = now().toISOString()
        let ids = sessions.get(e.sessionID)
        if (!ids) {
          ids = new Set<string>()
          sessions.set(e.sessionID, ids)
        }
        ids.add(e.id)
        await flush()
      },

      handleStepEnded: async (e: StepEnded): Promise<void> => {
        const ids = sessions.get(e.sessionID)
        if (!ids || ids.size === 0) return
        const share = 1 / ids.size
        const input = (e.tokens.input ?? 0) * share
        const output = (e.tokens.output ?? 0) * share
        const reasoning = (e.tokens.reasoning ?? 0) * share
        const cacheRead = (e.tokens.cache?.read ?? 0) * share
        const cacheWrite = (e.tokens.cache?.write ?? 0) * share
        const lastUsed = now().toISOString()
        for (const id of ids) {
          const stats = statsFor(id)
          stats.spend.input += input
          stats.spend.output += output
          stats.spend.reasoning += reasoning
          stats.spend.cacheRead += cacheRead
          stats.spend.cacheWrite += cacheWrite
          stats.lastUsed = lastUsed
        }
        await flush()
      },

      reset: async (): Promise<void> => {
        current = emptyData()
        sessions.clear()
        await flush()
      },

      data: (): UsageData => current,
    }
  })
}
