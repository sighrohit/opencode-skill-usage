import { dirname } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { emptyData, type UsageData } from "./types.js"

export interface Store {
  load(): Promise<UsageData>
  save(data: UsageData): Promise<void>
}

export const STORAGE_KEY = "skill-usage:stats"

function toUsageData(raw: unknown): UsageData {
  if (typeof raw !== "object" || raw === null) return emptyData()
  const record = raw as Record<string, unknown>
  if (record["version"] !== 1) return emptyData()
  const skills = record["skills"]
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) return emptyData()
  return { version: 1, skills: skills as UsageData["skills"] }
}

export function createPluginStore(storage: {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}): Store {
  return {
    load: async (): Promise<UsageData> => {
      try {
        const raw = await storage.get(STORAGE_KEY)
        if (raw === undefined) return emptyData()
        return toUsageData(raw)
      } catch {
        return emptyData()
      }
    },
    save: async (data: UsageData): Promise<void> => {
      await storage.set(STORAGE_KEY, data)
    },
  }
}

export function createFileStore(filePath: string): Store {
  return {
    load: async (): Promise<UsageData> => {
      try {
        const text = await readFile(filePath, "utf8")
        return toUsageData(JSON.parse(text))
      } catch {
        return emptyData()
      }
    },
    save: async (data: UsageData): Promise<void> => {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(data))
    },
  }
}
