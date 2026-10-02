import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyData } from "./types.js"
import { createFileStore, createPluginStore } from "./store.js"

function createFakeStorage() {
  const map = new Map<string, unknown>()
  return {
    map,
    storage: {
      get: async (key: string): Promise<unknown> => map.get(key),
      set: async (key: string, value: unknown): Promise<void> => {
        map.set(key, value)
      },
    },
  }
}

let tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
  tmpDirs = []
})

async function freshTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-usage-store-"))
  tmpDirs.push(dir)
  return dir
}

function sampleData() {
  return {
    version: 1 as const,
    skills: {
      "my-skill": {
        loads: 2,
        contentTokens: 500,
        spend: { input: 10, output: 20, reasoning: 30, cacheRead: 40, cacheWrite: 50 },
        lastUsed: "2026-10-02T00:00:00.000Z",
      },
    },
  }
}

describe("createPluginStore", () => {
  it("load returns emptyData when nothing stored", async () => {
    const { storage } = createFakeStorage()
    const store = createPluginStore(storage)
    expect(await store.load()).toEqual(emptyData())
  })

  it("save then load round-trips", async () => {
    const { storage } = createFakeStorage()
    const store = createPluginStore(storage)
    const data = sampleData()
    await store.save(data)
    expect(await store.load()).toEqual(data)
  })

  it("load returns emptyData on version mismatch", async () => {
    const { storage, map } = createFakeStorage()
    map.set("skill-usage:stats", { version: 99, skills: sampleData().skills })
    const store = createPluginStore(storage)
    expect(await store.load()).toEqual(emptyData())
  })
})

describe("createFileStore", () => {
  it("load returns emptyData when nothing stored", async () => {
    const dir = await freshTmpDir()
    const store = createFileStore(join(dir, "skill-usage.json"))
    expect(await store.load()).toEqual(emptyData())
  })

  it("save then load round-trips", async () => {
    const dir = await freshTmpDir()
    const store = createFileStore(join(dir, "skill-usage.json"))
    const data = sampleData()
    await store.save(data)
    expect(await store.load()).toEqual(data)
  })

  it("load returns emptyData on version mismatch", async () => {
    const dir = await freshTmpDir()
    const filePath = join(dir, "skill-usage.json")
    await writeFile(filePath, JSON.stringify({ version: 99, skills: sampleData().skills }))
    const store = createFileStore(filePath)
    expect(await store.load()).toEqual(emptyData())
  })

  it("load returns emptyData on corrupt JSON", async () => {
    const dir = await freshTmpDir()
    const filePath = join(dir, "skill-usage.json")
    await writeFile(filePath, "not json{")
    const store = createFileStore(filePath)
    expect(await store.load()).toEqual(emptyData())
  })

  it("file store creates parent directories on save", async () => {
    const dir = await freshTmpDir()
    const filePath = join(dir, "nested", "deep", "skill-usage.json")
    const store = createFileStore(filePath)
    const data = sampleData()
    await store.save(data)
    expect(await store.load()).toEqual(data)
  })
})
