import { lstat, readdir, readFile, rmdir, unlink } from "node:fs/promises"
import { join, normalize, sep } from "node:path"
import { commitFile, tempOwnerPid } from "./durable-file.ts"
import { RECENT_LIMIT, memoryFilePath, parseMemory } from "./peek-memory.ts"
import { loadSettings } from "./settings.ts"

declare const shotKeyBrand: unique symbol
declare const budgetBytesBrand: unique symbol

const ID_TEXT = /^[A-Za-z0-9_-]+$/
const BYTES_PER_MB = 1024 * 1024

type ShotKey = string & { readonly [shotKeyBrand]: true }
type BudgetBytes = number & { readonly [budgetBytesBrand]: true }

type StoreShot = {
  readonly cacheDir: string
  readonly fileId: string
  readonly nodeId: string
  readonly bytes: Uint8Array
  readonly note: string | null
  readonly name: string | null
  readonly page: string | null
  readonly updatedAt: number | null
  readonly scale: number
}

type Protection =
  | { readonly kind: "known"; readonly keep: ReadonlySet<ShotKey> }
  | { readonly kind: "unknown" }

type Hold = {
  readonly dir: string | null
  readonly bytes: number
}

type Candidate = {
  readonly dir: string
  readonly storedAt: number
  readonly key: ShotKey
  readonly bytes: number
  readonly sidecar: string
  readonly jpeg: string
}

type SweepPlan = {
  readonly unlink: readonly string[]
  readonly removeDirs: readonly string[]
}

type SweepCensus = {
  readonly holds: readonly Hold[]
  readonly candidates: readonly Candidate[]
  readonly debris: readonly string[]
  readonly childDirs: readonly string[]
  readonly occupiedDirs: readonly string[]
}

type ShotSidecar = {
  name: string | null
  file: string
  page: string | null
  timestamp: string
  note: string | null
  byteLength: number
  // The scale that was asked of Paper, not the one it delivered. Paper caps a
  // shot's long edge, so a wide artboard asked for at 2 comes back at less
  // than twice its size. Recording the request is what lets a stale shot be
  // spotted once and then settle; recording the delivered size would leave
  // every capped artboard looking stale forever.
  scale: number
  updatedAt?: number
}

type SideFile = {
  readonly size: number
  readonly text: string | null
  readonly read: boolean
}

type SlotFiles = {
  readonly jpeg: SideFile | null
  readonly sidecar: SideFile | null
}

type SidecarRead = {
  readonly storedAt: number | null
  readonly byteLength: number | null
  readonly fileBytes: number
}

type Observed =
  | { readonly kind: "absent" }
  | { readonly kind: "foreign" }
  | { readonly kind: "file"; readonly file: SideFile }

export async function storeShot(input: StoreShot): Promise<void> {
  const jpeg = shotJpegPath(input.cacheDir, input.fileId, input.nodeId)
  await commitFile(jpeg, input.bytes)
  await commitFile(sidecarPath(jpeg), textBytes(JSON.stringify(shotRecord(input))))
  try {
    await reconcile(input.cacheDir)
  } catch {
    return
  }
}

export async function readShotStamp(cacheDir: string, fileId: string, nodeId: string): Promise<number | null> {
  const parsed = await readSidecarRecord(cacheDir, fileId, nodeId)
  if (parsed === null) return null
  if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) return null
  return parsed.updatedAt
}

// A shot stored before the plugin asked for a bigger one has no scale on its
// sidecar at all, so a missing field reads as 1 rather than as unknown.
export async function readShotScale(cacheDir: string, fileId: string, nodeId: string): Promise<number | null> {
  const parsed = await readSidecarRecord(cacheDir, fileId, nodeId)
  if (parsed === null) return null
  if (typeof parsed.scale !== "number" || !Number.isFinite(parsed.scale) || parsed.scale <= 0) return 1
  return parsed.scale
}

export async function sidecarNote(
  cacheDir: string,
  fileId: string,
  nodeId: string,
  byteLength: number,
): Promise<string | null> {
  const parsed = await readSidecarRecord(cacheDir, fileId, nodeId)
  if (parsed === null || parsed.byteLength !== byteLength) return null
  if (parsed.note === null) return null
  if (typeof parsed.note !== "string") return null
  return parsed.note
}

export function shotJpegPath(cacheDir: string, fileId: string, nodeId: string): string {
  if (!singleComponent(fileId) || !singleComponent(nodeId)) {
    throw new Error("shot id must be a single path component")
  }
  return join(cacheDir, "shots", fileId, `${nodeId}.jpg`)
}

function shotRecord(input: StoreShot): ShotSidecar {
  const record: ShotSidecar = {
    name: input.name,
    file: input.fileId,
    page: input.page,
    timestamp: new Date().toISOString(),
    note: input.note,
    byteLength: input.bytes.byteLength,
    scale: input.scale,
  }
  if (input.updatedAt === null) return record
  return { ...record, updatedAt: input.updatedAt }
}

function sidecarPath(jpegPath: string): string {
  return `${jpegPath.slice(0, -".jpg".length)}.json`
}

function budgetBytes(megabytes: number): BudgetBytes {
  return (megabytes * BYTES_PER_MB) as BudgetBytes
}

function shotKey(fileId: string, nodeId: string): ShotKey {
  return `${fileId}/${nodeId}` as ShotKey
}

async function reconcile(cacheDir: string): Promise<void> {
  const shotsDir = join(cacheDir, "shots")
  const protection = await loadProtection()
  const budget = budgetBytes(loadSettings().settings.cacheBudgetMb)
  const census = await collectCensus(shotsDir, protection)
  await applyPlan(shotsDir, planShotSweep(census, budget))
}

async function loadProtection(): Promise<Protection> {
  let text: string
  try {
    text = await readFile(memoryFilePath(), "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { kind: "known", keep: new Set() }
    return { kind: "unknown" }
  }
  const parsed = parsedObject(text)
  if (parsed === null) return { kind: "unknown" }
  const memory = parseMemory(text)
  const keep = new Set<ShotKey>()
  if (memory.current !== null) keep.add(shotKey(memory.current.fileId, memory.current.nodeId))
  for (const place of memory.recent.slice(0, RECENT_LIMIT)) {
    keep.add(shotKey(place.fileId, place.nodeId))
  }
  const loose = looseKey(parsed)
  if (loose !== null) keep.add(loose)
  return { kind: "known", keep }
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function looseKey(record: Record<string, unknown>): ShotKey | null {
  if (typeof record.fileId !== "string" || typeof record.nodeId !== "string") return null
  if (!ID_TEXT.test(record.fileId) || !ID_TEXT.test(record.nodeId)) return null
  return shotKey(record.fileId, record.nodeId)
}

async function collectCensus(shotsDir: string, protection: Protection): Promise<SweepCensus> {
  let entries
  try {
    entries = await readdir(shotsDir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { holds: [], candidates: [], debris: [], childDirs: [], occupiedDirs: [] }
    throw error
  }
  const holds: Hold[] = []
  const candidates: Candidate[] = []
  const debris: string[] = []
  const childDirs: string[] = []
  const occupiedDirs: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (!singleComponent(entry.name)) continue
      childDirs.push(entry.name)
      await censusDirectory(shotsDir, entry.name, protection, holds, candidates, debris, occupiedDirs)
      continue
    }
    await censusTopFile(entry.name, debris)
  }
  return { holds, candidates, debris, childDirs, occupiedDirs }
}

async function censusTopFile(name: string, debris: string[]): Promise<void> {
  const owner = tempOwnerPid(name)
  if (owner === null) return
  if (await tempIsDebris(owner)) debris.push(name)
}

async function censusDirectory(
  shotsDir: string,
  dir: string,
  protection: Protection,
  holds: Hold[],
  candidates: Candidate[],
  debris: string[],
  occupiedDirs: string[],
): Promise<void> {
  let children
  try {
    children = await readdir(join(shotsDir, dir), { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return
    throw error
  }
  const slots = new Map<string, SlotFiles>()
  let blocked = false
  for (const child of children) {
    const name = child.name
    if (!singleComponent(name)) {
      blocked = true
      continue
    }
    const owner = tempOwnerPid(name)
    if (owner !== null) {
      if (await tempIsDebris(owner)) debris.push(`${dir}/${name}`)
      else occupiedDirs.push(dir)
      continue
    }
    if (child.isDirectory() && !child.isSymbolicLink()) {
      blocked = true
      continue
    }
    const slotName = slotNameOf(name)
    if (slotName === null) {
      blocked = true
      continue
    }
    const observed = await observe(join(shotsDir, dir, name), slotName.ext === "json")
    if (observed.kind === "absent") continue
    if (observed.kind === "foreign") {
      blocked = true
      continue
    }
    const current = slots.get(slotName.stem) ?? { jpeg: null, sidecar: null }
    if (slotName.ext === "jpg") slots.set(slotName.stem, { jpeg: observed.file, sidecar: current.sidecar })
    else slots.set(slotName.stem, { jpeg: current.jpeg, sidecar: observed.file })
  }
  for (const [stem, slot] of slots) {
    if (classifySlot(dir, stem, slot, protection, holds, candidates, debris)) blocked = true
  }
  if (blocked) occupiedDirs.push(dir)
}

function classifySlot(
  dir: string,
  stem: string,
  slot: SlotFiles,
  protection: Protection,
  holds: Hold[],
  candidates: Candidate[],
  debris: string[],
): boolean {
  const jpegRel = `${dir}/${stem}.jpg`
  const sideRel = `${dir}/${stem}.json`
  const facts = slot.sidecar === null ? null : sidecarFacts(slot.sidecar)
  if (slot.jpeg !== null) {
    const bytes = weight(slot.jpeg.size, facts)
    const key = shotKey(dir, stem)
    if (protection.kind === "unknown" || protection.keep.has(key)) {
      holds.push({ dir, bytes })
      return false
    }
    if (facts !== null && facts.storedAt !== null) {
      candidates.push({ dir, storedAt: facts.storedAt, key, bytes, sidecar: sideRel, jpeg: jpegRel })
      return false
    }
    if (slot.sidecar !== null) debris.push(sideRel)
    debris.push(jpegRel)
    return false
  }
  if (slot.sidecar !== null && protection.kind === "known") {
    debris.push(sideRel)
    return false
  }
  return slot.sidecar !== null
}

function planShotSweep(census: SweepCensus, budget: BudgetBytes): SweepPlan {
  let total = 0
  for (const hold of census.holds) total += hold.bytes
  for (const candidate of census.candidates) total += candidate.bytes
  const sorted = [...census.candidates].sort(compareCandidates)
  const unlink = [...census.debris]
  const occupied = new Set<string>(census.occupiedDirs)
  for (const hold of census.holds) {
    if (hold.dir !== null) occupied.add(hold.dir)
  }
  for (const candidate of sorted) {
    if (total <= budget) {
      occupied.add(candidate.dir)
      continue
    }
    unlink.push(candidate.sidecar)
    unlink.push(candidate.jpeg)
    total -= candidate.bytes
  }
  return {
    unlink,
    removeDirs: census.childDirs.filter((dir) => !occupied.has(dir)),
  }
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.storedAt < b.storedAt) return -1
  if (a.storedAt > b.storedAt) return 1
  if (a.key < b.key) return -1
  if (a.key > b.key) return 1
  return 0
}

async function applyPlan(shotsDir: string, plan: SweepPlan): Promise<void> {
  for (const rel of plan.unlink) {
    const abs = insideShots(shotsDir, rel)
    if (abs === null) continue
    try {
      await unlink(abs)
    } catch {
      continue
    }
  }
  for (const dir of plan.removeDirs) {
    if (!singleComponent(dir)) continue
    try {
      await rmdir(join(shotsDir, dir))
    } catch {
      continue
    }
  }
}

function insideShots(shotsDir: string, rel: string): string | null {
  if (rel === "" || rel.includes("\0")) return null
  const parts = rel.split("/")
  if (parts.some((part) => !singleComponent(part))) return null
  const root = normalize(shotsDir)
  const abs = normalize(join(root, ...parts))
  if (abs === root) return null
  if (!abs.startsWith(root + sep)) return null
  return abs
}

async function tempIsDebris(owner: number | "bare"): Promise<boolean> {
  if (owner === "bare") return true
  if (owner === process.pid) return true
  return !(await writerStillRunning(owner))
}

async function writerStillRunning(pid: number): Promise<boolean> {
  try {
    await lstat(`/proc/${pid}`)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Only a missing /proc entry shows that the writer has exited.
    return code !== "ENOENT"
  }
}

async function observe(path: string, readText: boolean): Promise<Observed> {
  let size = 0
  let linked = false
  try {
    const stat = await lstat(path)
    if (!stat.isFile() && !stat.isSymbolicLink()) return { kind: "foreign" }
    size = stat.size
    linked = stat.isSymbolicLink()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { kind: "absent" }
    throw error
  }
  if (!readText || linked) return { kind: "file", file: { size, text: null, read: false } }
  try {
    const text = await readFile(path, "utf8")
    return { kind: "file", file: { size, text, read: true } }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { kind: "absent" }
    return { kind: "file", file: { size, text: null, read: false } }
  }
}

function sidecarFacts(file: SideFile): SidecarRead | null {
  if (!file.read || file.text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(file.text) as unknown
  } catch {
    return { storedAt: null, byteLength: null, fileBytes: file.size }
  }
  if (!isRecord(parsed)) return { storedAt: null, byteLength: null, fileBytes: file.size }
  let storedAt: number | null = null
  if (typeof parsed.timestamp === "string") {
    const parsedAt = Date.parse(parsed.timestamp)
    if (Number.isFinite(parsedAt)) storedAt = parsedAt
  }
  const byteLength = nonNegativeInteger(parsed.byteLength)
  return { storedAt, byteLength, fileBytes: file.size }
}

function weight(jpegSize: number, facts: SidecarRead | null): number {
  if (facts === null) return jpegSize
  const image = facts.byteLength === null ? jpegSize : facts.byteLength
  return image + facts.fileBytes
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null
  return value
}

function slotNameOf(name: string): { readonly stem: string; readonly ext: "jpg" | "json" } | null {
  const match = /^(.*)\.(jpg|json)$/.exec(name)
  const stem = match?.[1]
  const ext = match?.[2]
  if (stem === undefined || (ext !== "jpg" && ext !== "json")) return null
  if (!singleComponent(stem)) return null
  return { stem, ext }
}

function singleComponent(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false
  return true
}

async function readSidecarRecord(
  cacheDir: string,
  fileId: string,
  nodeId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(sidecarPath(shotJpegPath(cacheDir, fileId, nodeId)), "utf8")
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
