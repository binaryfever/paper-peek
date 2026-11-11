import { realpathSync } from "node:fs"
import {
  GONE_NOTICE,
  artboardRows,
  forgetArtboard,
  memoryFilePath,
  memoryText,
  pageRows,
  parseMemory,
  projectRows,
  remember,
  type ArtboardPlace,
  type BrowserRow,
  type ListedFile,
  type PeekMemory,
} from "./peek-memory.ts"
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { commitFile } from "./durable-file.ts"
import { readShotScale, readShotStamp, shotJpegPath, sidecarNote, storeShot } from "./shot-cache.ts"
import { configuredPaperUrl, ensureSettingsDir, installHotkeys, loadSettings, settingsPayload } from "./settings.ts"

declare const fileIdBrand: unique symbol
declare const nodeIdBrand: unique symbol
declare const folderIdBrand: unique symbol
declare const pageIdBrand: unique symbol
const paperSourceBrand = Symbol("paper-source")

const ID_TEXT = /^[A-Za-z0-9_-]+$/
const PLUGIN_TOOLS = ["list_resources", "get_basic_info", "get_screenshot"] as const

// Paper renders a shot at the artboard's own size. The drawer draws it small,
// where that is plenty, and the big view draws it several times larger, where
// it is soft. One fetch serves both views, so a shot is asked for at 2 and
// the drawer decodes it at whatever width it is drawing.
const SHOT_SCALE = 2
// The width-measuring call is a different question: it wants the artboard's
// own width, which is what Paper answers at 1.
const MEASURE_SCALE = 1

type PluginTool = (typeof PLUGIN_TOOLS)[number]

export type FileId = string & { readonly [fileIdBrand]: true }
export type NodeId = string & { readonly [nodeIdBrand]: true }
export type FolderId = string & { readonly [folderIdBrand]: true }
export type PageId = string & { readonly [pageIdBrand]: true }
export type PeekStatus = "live" | "not-live" | "off"

export type OpenFile = {
  readonly kind: "open-file"
  readonly id: FileId
  readonly name: string
  readonly folder: FolderId | null
  readonly active: boolean
}

export type ClosedFile = {
  readonly kind: "closed-file"
  readonly id: FileId
  readonly name: string
  readonly folder: FolderId | null
}

export type FolderResource = {
  readonly kind: "folder"
  readonly id: FolderId
  readonly name: string
}

export type ProjectResource = OpenFile | ClosedFile | FolderResource

export type ProjectIndex = {
  readonly resources: readonly ProjectResource[]
  readonly truncated: boolean
}

export type ProjectResult =
  | { readonly kind: "fresh"; readonly index: ProjectIndex }
  | { readonly kind: "cached"; readonly index: ProjectIndex }
  | { readonly kind: "unavailable"; readonly reason: "paper-down" | "bad-payload" }

export type ArtboardTarget = {
  readonly fileId: FileId
  readonly nodeId: NodeId
}

export type ArtboardImage = {
  readonly fileId: FileId
  readonly nodeId: NodeId
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly note: string | null
  readonly imagePath: string
}

export type ShotRefusal =
  | "file-closed"
  | "not-a-file"
  | "unknown-file"
  | "list-truncated"
  | "paper-down"
  | "bad-image"
  | "bad-payload"

export type ArtboardResult =
  | { readonly kind: "fresh"; readonly image: ArtboardImage }
  | { readonly kind: "cached"; readonly image: ArtboardImage; readonly reason: ShotRefusal }
  | { readonly kind: "unavailable"; readonly reason: ShotRefusal }

export type WatchResult =
  | { readonly kind: "changed" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "down" }

export type StoredProjects =
  | { readonly kind: "cached"; readonly index: ProjectIndex }
  | { readonly kind: "unavailable" }

export type StoredArtboard =
  | { readonly kind: "cached"; readonly image: ArtboardImage }
  | { readonly kind: "unavailable" }

export type LivePaperOptions = {
  readonly endpoint?: string
  readonly cacheDir?: string
}

export type PaperScript = {
  readonly cacheDir: string
  readonly listResources: () => unknown
  readonly screenshot?: (target: {
    readonly fileId: string
    readonly nodeId: string
    readonly scale: number
  }) => unknown
  readonly basicInfo?: (target: { readonly fileId: string; readonly pageId?: string }) => unknown
}

export type CachedPage = {
  readonly id: PageId
  readonly name: string
  readonly order: number
}

export type PageCatalog = {
  readonly fileId: FileId
  readonly pages: readonly CachedPage[]
}

export type PageResult =
  | { readonly kind: "fresh"; readonly catalog: PageCatalog }
  | { readonly kind: "cached"; readonly catalog: PageCatalog }
  | { readonly kind: "unavailable"; readonly reason: "paper-down" | "bad-payload" }

export type CachedArtboard = {
  readonly id: NodeId
  readonly name: string
  readonly width: number | null
}

export type ArtboardCatalog = {
  readonly fileId: FileId
  readonly pageId: PageId
  readonly artboards: readonly CachedArtboard[]
}

export type ArtboardCatalogResult =
  | { readonly kind: "fresh"; readonly catalog: ArtboardCatalog }
  | { readonly kind: "cached"; readonly catalog: ArtboardCatalog }
  | { readonly kind: "unavailable"; readonly reason: "paper-down" | "bad-payload" }

export type PaperSource = { readonly [paperSourceBrand]: true }

type LiveBackend = {
  readonly kind: "live"
  readonly endpoint: string
  readonly cacheDir: string
  sessionId: string | null
  nextId: number
}

type ScriptBackend = {
  readonly kind: "script"
  readonly script: PaperScript
}

type Backend = LiveBackend | ScriptBackend

type Frame = {
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
  readonly note: string | null
}

type ShotGate =
  | { readonly kind: "fetch"; readonly file: OpenFile }
  | {
      readonly kind: "refuse"
      readonly reason: "file-closed" | "not-a-file" | "unknown-file" | "list-truncated"
    }

class Fail {
  readonly reason: "paper-down" | "bad-payload" | "bad-image"
  constructor(reason: "paper-down" | "bad-payload" | "bad-image") {
    this.reason = reason
  }
}

const backends = new WeakMap<PaperSource, Backend>()

export function parseFileId(raw: string): FileId | null {
  if (!ID_TEXT.test(raw)) return null
  return raw as FileId
}

export function parseNodeId(raw: string): NodeId | null {
  if (!ID_TEXT.test(raw)) return null
  return raw as NodeId
}

export function parsePageId(raw: string): PageId | null {
  if (!ID_TEXT.test(raw)) return null
  return raw as PageId
}

function parseFolderId(raw: string): FolderId | null {
  if (!ID_TEXT.test(raw)) return null
  return raw as FolderId
}

export function livePaper(options?: LivePaperOptions): PaperSource {
  const endpoint = configuredPaperUrl(options?.endpoint)
  const cacheDir =
    options?.cacheDir !== undefined && options.cacheDir !== ""
      ? options.cacheDir
      : envValue("PAPER_PEEK_CACHE") ?? join(homedir(), ".cache", "paper-peek")
  const source: PaperSource = { [paperSourceBrand]: true }
  backends.set(source, { kind: "live", endpoint, cacheDir, sessionId: null, nextId: 1 })
  return source
}

export function scriptedPaper(script: PaperScript): PaperSource {
  const source: PaperSource = { [paperSourceBrand]: true }
  backends.set(source, { kind: "script", script })
  return source
}

export function artboardChosen(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false
  if (typeof parsed.fileId !== "string" || typeof parsed.nodeId !== "string") return false
  return parseFileId(parsed.fileId) !== null && parseNodeId(parsed.nodeId) !== null
}

export function peekStatus(reachable: boolean, chosen: boolean): PeekStatus {
  if (!chosen) return "off"
  return reachable ? "live" : "not-live"
}

export async function reportStatus(source: PaperSource, currentText: string): Promise<PeekStatus> {
  if (!artboardChosen(currentText)) return peekStatus(false, false)
  return peekStatus(await paperReachable(source), true)
}

export async function listProjects(source: PaperSource): Promise<ProjectResult> {
  const loaded = await readResourceList(source)
  if (loaded instanceof Fail) {
    return fallbackProjects(source, loaded.reason === "bad-payload" ? "bad-payload" : "paper-down")
  }
  await commitFile(
    join(cacheDirOf(source), "projects.json"),
    textBytes(JSON.stringify(loaded.index)),
  )
  return { kind: "fresh", index: loaded.index }
}

export async function fetchArtboard(
  source: PaperSource,
  target: ArtboardTarget,
): Promise<ArtboardResult> {
  const loaded = await readResourceList(source)
  if (loaded instanceof Fail) {
    return storedShot(source, target, loaded.reason === "bad-payload" ? "bad-payload" : "paper-down")
  }
  await commitFile(
    join(cacheDirOf(source), "projects.json"),
    textBytes(JSON.stringify(loaded.index)),
  )
  const gate = decideShot({ kind: "fresh", index: loaded.index }, target)
  if (gate.kind === "refuse") return storedShot(source, target, gate.reason)
  try {
    const raw = await postTool(source, "get_screenshot", target, SHOT_SCALE)
    const frame = jpegFromToolResult(raw)
    if (frame instanceof Fail) return storedShot(source, target, frame.reason)
    const cacheDir = cacheDirOf(source)
    const placed = await findCachedArtboard(cacheDir, target)
    await storeShot({
      cacheDir,
      fileId: target.fileId,
      nodeId: target.nodeId,
      bytes: frame.bytes,
      note: frame.note,
      name: placed === null ? null : placed.name,
      page: placed === null ? null : placed.page,
      updatedAt: fileUpdatedAt(loaded.raw, target.fileId),
      scale: SHOT_SCALE,
    })
    const stored = await readArtboard(source, target)
    if (stored.kind !== "cached") return { kind: "unavailable", reason: "bad-image" }
    return { kind: "fresh", image: stored.image }
  } catch (err) {
    const reason = err instanceof Fail ? err.reason : "paper-down"
    return storedShot(source, target, reason)
  }
}

export async function watchArtboard(
  source: PaperSource,
  target: ArtboardTarget,
): Promise<WatchResult> {
  const loaded = await readResourceList(source)
  if (loaded instanceof Fail) return { kind: "down" }
  const gate = decideShot({ kind: "fresh", index: loaded.index }, target)
  if (gate.kind === "refuse") return { kind: "unchanged" }
  // A shot cached before the plugin started asking for 2 is soft in the big
  // view, and nothing about the file has changed for Paper to report. Only a
  // check for the scale on the sidecar gets it replaced. The sidecar records
  // what was asked for rather than what came back, so a capped artboard reads
  // as current and this settles after one refetch instead of looping.
  const scale = await readShotScale(cacheDirOf(source), target.fileId, target.nodeId)
  if (scale !== null && scale < SHOT_SCALE) return { kind: "changed" }
  const stamp = fileUpdatedAt(loaded.raw, target.fileId)
  if (stamp === null) return { kind: "unchanged" }
  const seen = await readShotStamp(cacheDirOf(source), target.fileId, target.nodeId)
  if (seen === stamp) return { kind: "unchanged" }
  return { kind: "changed" }
}

async function readResourceList(
  source: PaperSource,
): Promise<{ readonly raw: unknown; readonly index: ProjectIndex } | Fail> {
  let raw: unknown
  try {
    raw = await postTool(source, "list_resources", null)
  } catch (err) {
    if (err instanceof Fail && err.reason !== "bad-image") return err
    return new Fail("paper-down")
  }
  const index = parseToolIndex(raw)
  if (index instanceof Fail) return index
  return { raw, index }
}

export async function readProjects(source: PaperSource): Promise<StoredProjects> {
  try {
    const text = await readFile(join(cacheDirOf(source), "projects.json"), "utf8")
    const index = parseStoredIndex(JSON.parse(text) as unknown)
    if (index === null) return { kind: "unavailable" }
    return { kind: "cached", index }
  } catch {
    return { kind: "unavailable" }
  }
}

export async function readArtboard(
  source: PaperSource,
  target: ArtboardTarget,
): Promise<StoredArtboard> {
  const jpegPath = shotJpegPath(cacheDirOf(source), target.fileId, target.nodeId)
  let bytes: Uint8Array
  try {
    bytes = await readFile(jpegPath)
  } catch {
    return { kind: "unavailable" }
  }
  const size = jpegSize(bytes)
  if (size === null) return { kind: "unavailable" }
  return {
    kind: "cached",
    image: {
      fileId: target.fileId,
      nodeId: target.nodeId,
      width: size.width,
      height: size.height,
      byteLength: bytes.byteLength,
      note: await sidecarNote(cacheDirOf(source), target.fileId, target.nodeId, bytes.byteLength),
      imagePath: jpegPath,
    },
  }
}

export async function listPages(
  source: PaperSource,
  fileId: FileId,
  refresh: boolean,
): Promise<PageResult> {
  if (!refresh) {
    const stored = await readPageCatalog(cacheDirOf(source), fileId)
    if (stored !== null) return { kind: "cached", catalog: stored }
  }
  let raw: unknown
  try {
    raw = await postTool(source, "get_basic_info", { fileId })
  } catch (err) {
    return { kind: "unavailable", reason: downOrPayload(err) }
  }
  const catalog = parsePageCatalog(fileId, raw)
  if (catalog instanceof Fail) return { kind: "unavailable", reason: "bad-payload" }
  await commitFile(pagesPath(cacheDirOf(source), fileId), textBytes(JSON.stringify(catalog)))
  return { kind: "fresh", catalog }
}

export async function listArtboards(
  source: PaperSource,
  fileId: FileId,
  pageId: PageId,
  refresh: boolean,
): Promise<ArtboardCatalogResult> {
  if (!refresh) {
    const stored = await readArtboardCatalog(cacheDirOf(source), fileId, pageId)
    if (stored !== null) return { kind: "cached", catalog: stored }
  }
  let raw: unknown
  try {
    raw = await postTool(source, "get_basic_info", { fileId, pageId })
  } catch (err) {
    return { kind: "unavailable", reason: downOrPayload(err) }
  }
  const parsed = parseArtboardCatalog(fileId, pageId, raw)
  if (parsed instanceof Fail) return { kind: "unavailable", reason: "bad-payload" }
  const filled = await fillMissingWidths(source, parsed)
  if (filled instanceof Fail) return { kind: "unavailable", reason: downOrPayload(filled) }
  await commitFile(
    artboardsPath(cacheDirOf(source), fileId, pageId),
    textBytes(JSON.stringify(filled)),
  )
  return { kind: "fresh", catalog: filled }
}

function downOrPayload(err: unknown): "paper-down" | "bad-payload" {
  if (err instanceof Fail && err.reason !== "paper-down") return "bad-payload"
  return "paper-down"
}

function decideShot(
  listed: Extract<ProjectResult, { readonly kind: "fresh" }>,
  target: ArtboardTarget,
): ShotGate {
  const match = listed.index.resources.find((resource) => resource.id === target.fileId)
  if (match === undefined) {
    return {
      kind: "refuse",
      reason: listed.index.truncated ? "list-truncated" : "unknown-file",
    }
  }
  if (match.kind === "folder") return { kind: "refuse", reason: "not-a-file" }
  if (match.kind === "closed-file") return { kind: "refuse", reason: "file-closed" }
  return { kind: "fetch", file: match }
}

type BasicInfoRequest = {
  readonly fileId: string
  readonly pageId?: string
}

function isShotTarget(target: ArtboardTarget | BasicInfoRequest): target is ArtboardTarget {
  return "nodeId" in target
}

function toolArguments(
  name: PluginTool,
  target: ArtboardTarget | BasicInfoRequest | null,
  scale: number,
):
  | { readonly limit: 200 }
  | { readonly fileId: string; readonly nodeId: string; readonly scale: number }
  | { readonly fileId: string; readonly pageId?: string } {
  switch (name) {
    case "list_resources":
      return { limit: 200 }
    case "get_screenshot":
      if (target === null || !isShotTarget(target)) throw new Fail("bad-payload")
      return { fileId: target.fileId, nodeId: target.nodeId, scale }
    case "get_basic_info":
      if (target === null || isShotTarget(target)) throw new Fail("bad-payload")
      if (target.pageId !== undefined) return { fileId: target.fileId, pageId: target.pageId }
      return { fileId: target.fileId }
  }
}

async function paperReachable(source: PaperSource): Promise<boolean> {
  try {
    const raw = await postTool(source, "list_resources", null)
    return !(parseToolIndex(raw) instanceof Fail)
  } catch {
    return false
  }
}

async function postTool(
  source: PaperSource,
  name: PluginTool,
  target: ArtboardTarget | BasicInfoRequest | null,
  scale: number = MEASURE_SCALE,
): Promise<unknown> {
  const backend = backendOf(source)
  if (backend.kind === "script") {
    if (name === "list_resources") return backend.script.listResources()
    if (name === "get_basic_info") {
      if (backend.script.basicInfo === undefined || target === null || isShotTarget(target)) {
        throw new Fail("paper-down")
      }
      return backend.script.basicInfo({ fileId: target.fileId, pageId: target.pageId })
    }
    if (target === null || !isShotTarget(target) || backend.script.screenshot === undefined) {
      throw new Fail("paper-down")
    }
    return backend.script.screenshot({ fileId: target.fileId, nodeId: target.nodeId, scale })
  }
  if (backend.sessionId === null) {
    await rpc(backend, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "paper-fetch", version: "0.0.1" },
    })
  }
  return rpc(backend, "tools/call", {
    name,
    arguments: toolArguments(name, target, scale),
  })
}

async function rpc(
  backend: LiveBackend,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  if (backend.sessionId !== null) headers["Mcp-Session-Id"] = backend.sessionId
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: backend.nextId++,
    method,
    params,
  })
  let response: Response
  try {
    response = await fetch(backend.endpoint, { method: "POST", headers, body })
  } catch {
    throw new Fail("paper-down")
  }
  if (response.status !== 200) throw new Fail("paper-down")
  const sessionId = response.headers.get("mcp-session-id")
  if (sessionId !== null && sessionId.length > 0) backend.sessionId = sessionId
  const text = await response.text()
  const envelope = parseSse(text)
  if (envelope instanceof Fail) throw envelope
  if (envelope.error !== undefined) throw new Fail("bad-payload")
  return envelope.result
}

function parseSse(body: string): { readonly result: unknown; readonly error?: unknown } | Fail {
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || !line.startsWith("event: message")) continue
    const dataLine = lines[i + 1]
    if (dataLine === undefined || !dataLine.startsWith("data: ")) return new Fail("bad-payload")
    try {
      const parsed = JSON.parse(dataLine.slice(6)) as unknown
      if (!isRecord(parsed) || !("result" in parsed)) return new Fail("bad-payload")
      return { result: parsed.result, error: parsed.error }
    } catch {
      return new Fail("bad-payload")
    }
  }
  return new Fail("bad-payload")
}

function parseToolIndex(raw: unknown): ProjectIndex | Fail {
  const page = wirePage(raw)
  if (page === null) return new Fail("bad-payload")
  const resources: ProjectResource[] = []
  const seen = new Set<string>()
  for (const item of page.items) {
    const resource = parseWireResource(item)
    if (resource instanceof Fail) return resource
    if (seen.has(resource.id)) return new Fail("bad-payload")
    seen.add(resource.id)
    resources.push(resource)
  }
  return { resources, truncated: page.truncated }
}

function parseWireResource(item: unknown): ProjectResource | Fail {
  if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) {
    return new Fail("bad-payload")
  }
  if (typeof item.id !== "string") return new Fail("bad-payload")
  if (item.type === "folder") {
    if (item.active === true) return new Fail("bad-payload")
    const id = parseFolderId(item.id)
    if (id === null) return new Fail("bad-payload")
    return { kind: "folder", id, name: item.name }
  }
  if (item.type !== "file") return new Fail("bad-payload")
  const id = parseFileId(item.id)
  if (id === null) return new Fail("bad-payload")
  const folder = folderOf(item)
  if (folder instanceof Fail) return folder
  if (item.open === true) {
    return { kind: "open-file", id, name: item.name, folder, active: item.active === true }
  }
  if (item.active === true) return new Fail("bad-payload")
  return { kind: "closed-file", id, name: item.name, folder }
}

function folderOf(item: Record<string, unknown>): FolderId | null | Fail {
  if (item.parentId === undefined || item.parentId === null) return null
  if (typeof item.parentId !== "string") return new Fail("bad-payload")
  const id = parseFolderId(item.parentId)
  if (id === null) return new Fail("bad-payload")
  return id
}

function jpegFromToolResult(raw: unknown): Frame | Fail {
  if (!isRecord(raw)) return new Fail("bad-payload")
  if (raw.isError === true) return new Fail("bad-payload")
  if (!Array.isArray(raw.content)) return new Fail("bad-payload")
  let imageIndex = -1
  let imageData = ""
  let imageCount = 0
  for (let i = 0; i < raw.content.length; i++) {
    const block = raw.content[i]
    if (!isRecord(block)) return new Fail("bad-payload")
    if (block.type === "image") {
      imageCount += 1
      imageIndex = i
      if (block.mimeType !== "image/jpeg" || typeof block.data !== "string") {
        return new Fail("bad-image")
      }
      imageData = block.data
      continue
    }
    if (block.type !== "text") return new Fail("bad-payload")
  }
  if (imageCount !== 1) return new Fail("bad-image")
  let note: string | null = null
  for (let i = imageIndex + 1; i < raw.content.length; i++) {
    const block = raw.content[i]
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      note = block.text
      break
    }
  }
  const bytes = Uint8Array.from(Buffer.from(imageData, "base64"))
  const size = jpegSize(bytes)
  if (size === null) return new Fail("bad-image")
  return { bytes, width: size.width, height: size.height, note }
}

function jpegSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    offset += 2
    if (marker === 0xd9) break
    if (marker >= 0xd0 && marker <= 0xd7) continue
    if (offset + 1 >= bytes.length) return null
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (segmentLength < 2) return null
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (offset + 7 >= bytes.length) return null
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!
      if (width <= 0 || height <= 0) return null
      return { width, height }
    }
    if (marker === 0xda) return null
    offset += segmentLength
  }
  return null
}

async function fallbackProjects(
  source: PaperSource,
  reason: "paper-down" | "bad-payload",
): Promise<ProjectResult> {
  const stored = await readProjects(source)
  if (stored.kind === "cached") return { kind: "cached", index: stored.index }
  return { kind: "unavailable", reason }
}

async function storedShot(
  source: PaperSource,
  target: ArtboardTarget,
  reason: ShotRefusal,
): Promise<ArtboardResult> {
  const stored = await readArtboard(source, target)
  if (stored.kind === "cached") return { kind: "cached", image: stored.image, reason }
  return { kind: "unavailable", reason }
}

function fileUpdatedAt(raw: unknown, fileId: FileId): number | null {
  const page = wirePage(raw)
  if (page === null) return null
  for (const item of page.items) {
    if (item.id !== fileId || item.type !== "file") continue
    if (typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt)) return null
    return item.updatedAt
  }
  return null
}

function wirePage(
  raw: unknown,
): { readonly items: readonly Record<string, unknown>[]; readonly truncated: boolean } | null {
  if (!isRecord(raw) || raw.isError === true || !Array.isArray(raw.content)) return null
  const pages: Record<string, unknown>[] = []
  for (const block of raw.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue
    try {
      const parsed = JSON.parse(block.text) as unknown
      if (isRecord(parsed) && Array.isArray(parsed.resources)) pages.push(parsed)
    } catch {
      return null
    }
  }
  if (pages.length !== 1) return null
  const page = pages[0]
  if (page === undefined || !Array.isArray(page.resources)) return null
  const items: Record<string, unknown>[] = []
  for (const item of page.resources) {
    if (!isRecord(item)) return null
    items.push(item)
  }
  return { items, truncated: page.truncated === true }
}

function parseStoredIndex(value: unknown): ProjectIndex | null {
  if (!isRecord(value) || typeof value.truncated !== "boolean" || !Array.isArray(value.resources)) {
    return null
  }
  const resources: ProjectResource[] = []
  const seen = new Set<string>()
  for (const item of value.resources) {
    const resource = parseStoredResource(item)
    if (resource === null) return null
    if (seen.has(resource.id)) return null
    seen.add(resource.id)
    resources.push(resource)
  }
  return { resources, truncated: value.truncated }
}

function parseStoredResource(item: unknown): ProjectResource | null {
  if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) return null
  if (typeof item.id !== "string") return null
  if (item.kind === "folder") {
    const id = parseFolderId(item.id)
    if (id === null) return null
    return { kind: "folder", id, name: item.name }
  }
  const folder = storedFolder(item)
  if (folder === "bad") return null
  if (item.kind === "open-file") {
    const id = parseFileId(item.id)
    if (id === null || typeof item.active !== "boolean") return null
    return { kind: "open-file", id, name: item.name, folder, active: item.active }
  }
  if (item.kind === "closed-file") {
    const id = parseFileId(item.id)
    if (id === null) return null
    return { kind: "closed-file", id, name: item.name, folder }
  }
  return null
}

function storedFolder(item: Record<string, unknown>): FolderId | null | "bad" {
  if (item.folder === undefined || item.folder === null) return null
  if (typeof item.folder !== "string") return "bad"
  const id = parseFolderId(item.folder)
  if (id === null) return "bad"
  return id
}

function pagesPath(dir: string, fileId: FileId): string {
  return join(dir, "pages", `${fileId}.json`)
}

function artboardsPath(dir: string, fileId: FileId, pageId: PageId): string {
  return join(dir, "artboards", fileId, `${pageId}.json`)
}

async function readPageCatalog(dir: string, fileId: FileId): Promise<PageCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(pagesPath(dir, fileId), "utf8")) as unknown
    if (!isPageCatalog(parsed, fileId)) return null
    return parsed
  } catch {
    return null
  }
}

async function readArtboardCatalog(
  dir: string,
  fileId: FileId,
  pageId: PageId,
): Promise<ArtboardCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(artboardsPath(dir, fileId, pageId), "utf8")) as unknown
    if (!isArtboardCatalog(parsed, fileId, pageId)) return null
    return parsed
  } catch {
    return null
  }
}

function isPageCatalog(value: unknown, fileId: FileId): value is PageCatalog {
  if (!isRecord(value) || value.fileId !== fileId || !Array.isArray(value.pages)) return false
  return value.pages.every((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return false
    if (item.name.length === 0 || parsePageId(item.id) === null) return false
    return item.order === index
  })
}

function isArtboardCatalog(value: unknown, fileId: FileId, pageId: PageId): value is ArtboardCatalog {
  if (!isRecord(value) || value.fileId !== fileId || value.pageId !== pageId) return false
  if (!Array.isArray(value.artboards)) return false
  return value.artboards.every((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return false
    if (item.name.length === 0 || parseNodeId(item.id) === null) return false
    return item.width === null || (typeof item.width === "number" && Number.isFinite(item.width) && item.width > 0)
  })
}

function jsonBlocks(raw: unknown): unknown[] | Fail {
  if (!isRecord(raw) || raw.isError === true || !Array.isArray(raw.content)) return new Fail("bad-payload")
  const found: unknown[] = []
  for (const block of raw.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue
    try {
      found.push(JSON.parse(block.text) as unknown)
    } catch {
      continue
    }
  }
  return found
}

function parsePageCatalog(fileId: FileId, raw: unknown): PageCatalog | Fail {
  const blocks = jsonBlocks(raw)
  if (blocks instanceof Fail) return blocks
  let pagesRaw: unknown[] | null = null
  for (const block of blocks) {
    if (isRecord(block) && Array.isArray(block.pages)) pagesRaw = block.pages
  }
  if (pagesRaw === null) return new Fail("bad-payload")
  const pages: CachedPage[] = []
  const seen = new Set<string>()
  for (const item of pagesRaw) {
    if (!isRecord(item) || item.type === "divider") continue
    if (item.type !== "page" || typeof item.id !== "string" || typeof item.name !== "string") {
      return new Fail("bad-payload")
    }
    if (item.name.length === 0) return new Fail("bad-payload")
    const id = parsePageId(item.id)
    if (id === null || seen.has(id)) return new Fail("bad-payload")
    seen.add(id)
    pages.push({ id, name: item.name, order: pages.length })
  }
  return { fileId, pages }
}

function parseArtboardCatalog(fileId: FileId, pageId: PageId, raw: unknown): ArtboardCatalog | Fail {
  const blocks = jsonBlocks(raw)
  if (blocks instanceof Fail) return blocks
  let body: Record<string, unknown> | null = null
  for (const block of blocks) {
    if (isRecord(block) && Array.isArray(block.artboards)) body = block
  }
  if (body === null) return new Fail("bad-payload")
  if (typeof body.pageId === "string" && body.pageId !== pageId) return new Fail("bad-payload")
  const artboards: CachedArtboard[] = []
  const seen = new Set<string>()
  const items = body.artboards
  if (!Array.isArray(items)) return new Fail("bad-payload")
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") {
      return new Fail("bad-payload")
    }
    if (item.name.length === 0) return new Fail("bad-payload")
    const id = parseNodeId(item.id)
    if (id === null || seen.has(id)) return new Fail("bad-payload")
    seen.add(id)
    if (item.width === null || item.width === undefined) {
      artboards.push({ id, name: item.name, width: null })
      continue
    }
    if (typeof item.width !== "number" || !Number.isFinite(item.width) || item.width <= 0) {
      return new Fail("bad-payload")
    }
    artboards.push({ id, name: item.name, width: item.width })
  }
  return { fileId, pageId, artboards }
}

async function fillMissingWidths(
  source: PaperSource,
  catalog: ArtboardCatalog,
): Promise<ArtboardCatalog | Fail> {
  const artboards: CachedArtboard[] = []
  for (const artboard of catalog.artboards) {
    if (artboard.width !== null) {
      artboards.push(artboard)
      continue
    }
    let raw: unknown
    try {
      raw = await postTool(
        source,
        "get_screenshot",
        { fileId: catalog.fileId, nodeId: artboard.id },
        MEASURE_SCALE,
      )
    } catch (err) {
      if (err instanceof Fail && err.reason === "bad-payload") return err
      return new Fail("paper-down")
    }
    const frame = jpegFromToolResult(raw)
    if (frame instanceof Fail) return frame
    artboards.push({ id: artboard.id, name: artboard.name, width: frame.width })
  }
  return { fileId: catalog.fileId, pageId: catalog.pageId, artboards }
}

async function findCachedArtboard(
  dir: string,
  target: ArtboardTarget,
): Promise<{ readonly name: string; readonly page: string } | null> {
  let names: string[]
  try {
    names = await readdir(join(dir, "artboards", target.fileId))
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(dir, "artboards", target.fileId, name), "utf8")) as unknown
    } catch {
      continue
    }
    if (!isRecord(parsed) || typeof parsed.pageId !== "string" || !Array.isArray(parsed.artboards)) {
      continue
    }
    for (const item of parsed.artboards) {
      if (!isRecord(item) || item.id !== target.nodeId || typeof item.name !== "string") continue
      return { name: item.name, page: parsed.pageId }
    }
  }
  return null
}

function cacheDirOf(source: PaperSource): string {
  const backend = backendOf(source)
  return backend.kind === "live" ? backend.cacheDir : backend.script.cacheDir
}

function backendOf(source: PaperSource): Backend {
  const backend = backends.get(source)
  if (backend === undefined) throw new Fail("paper-down")
  return backend
}

function stateHome(): string {
  return envValue("XDG_STATE_HOME") ?? join(homedir(), ".local", "state")
}

function statusFilePath(): string {
  const override = envValue("PAPER_PEEK_STATUS")
  if (override !== null && override !== "") return override
  return join(stateHome(), "paper-peek", "status")
}

function refreshLogPath(): string {
  const override = envValue("PAPER_PEEK_LOG")
  if (override !== null && override !== "") return override
  return join(stateHome(), "paper-peek", "refresh.log")
}

async function logRefresh(line: string): Promise<void> {
  const path = refreshLogPath()
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${line}\n`)
}

async function readCurrentArtboardText(): Promise<string> {
  try {
    return await readFile(memoryFilePath(), "utf8")
  } catch {
    return ""
  }
}

async function publishStatus(word: PeekStatus): Promise<void> {
  const path = statusFilePath()
  const body = `${word}\n`
  let same = false
  try {
    same = (await readFile(path, "utf8")) === body
  } catch {
    same = false
  }
  if (same) return
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.new`
  await writeFile(tmp, body)
  await rename(tmp, path)
}

function envValue(name: string): string | null {
  const value = process.env[name]
  if (value === undefined || value === "") return null
  return value
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type Command =
  | { readonly kind: "status" }
  | { readonly kind: "projects" }
  | { readonly kind: "pages"; readonly fileId: FileId; readonly refresh: boolean }
  | {
      readonly kind: "artboards"
      readonly fileId: FileId
      readonly pageId: PageId
      readonly refresh: boolean
    }
  | { readonly kind: "shot"; readonly fileId: FileId; readonly nodeId: NodeId }
  | { readonly kind: "watch"; readonly fileId: FileId; readonly nodeId: NodeId }
  | { readonly kind: "resolve" }
  | { readonly kind: "resolve-project"; readonly fileId: FileId }
  | { readonly kind: "remember"; readonly fileId: FileId; readonly pageId: PageId; readonly nodeId: NodeId }
  | { readonly kind: "browser-projects"; readonly refresh: boolean }
  | { readonly kind: "browser-pages"; readonly fileId: FileId; readonly refresh: boolean }
  | {
      readonly kind: "browser-artboards"
      readonly fileId: FileId
      readonly pageId: PageId
      readonly refresh: boolean
    }

type DrawerDirective =
  | { readonly kind: "shot" }
  | { readonly kind: "projects"; readonly notice: string }
  | { readonly kind: "pages"; readonly fileId: string; readonly notice: string }

type Presence = "present" | "missing-artboard" | "missing-file" | "unknown"

async function readMemory(): Promise<PeekMemory> {
  return parseMemory(await readCurrentArtboardText())
}

async function writeMemory(memory: PeekMemory): Promise<void> {
  const text = memoryText(memory)
  const path = memoryFilePath()
  let previous = ""
  try {
    previous = await readFile(path, "utf8")
  } catch {
    previous = ""
  }
  if (previous === text) return
  await commitFile(path, textBytes(text))
}

async function namesFor(
  source: PaperSource,
  fileId: FileId,
  pageId: PageId,
  nodeId: NodeId,
): Promise<ArtboardPlace> {
  let projectName = ""
  const projects = await readProjects(source)
  if (projects.kind === "cached") {
    for (const resource of projects.index.resources) {
      if (resource.kind !== "folder" && resource.id === fileId) projectName = resource.name
    }
  }
  const pages = await readPageCatalog(cacheDirOf(source), fileId)
  const page = pages?.pages.find((item) => item.id === pageId)
  const boards = await readArtboardCatalog(cacheDirOf(source), fileId, pageId)
  const artboard = boards?.artboards.find((item) => item.id === nodeId)
  return {
    fileId,
    pageId,
    nodeId,
    projectName,
    pageName: page?.name ?? "",
    artboardName: artboard?.name ?? "",
  }
}

async function artboardPresence(source: PaperSource, place: ArtboardPlace): Promise<Presence> {
  const fileId = parseFileId(place.fileId)
  const pageId = parsePageId(place.pageId)
  const nodeId = parseNodeId(place.nodeId)
  if (fileId === null || pageId === null || nodeId === null) return "missing-artboard"
  const loaded = await readResourceList(source)
  if (loaded instanceof Fail) return "unknown"
  const match = loaded.index.resources.find((resource) => resource.id === fileId)
  if (match === undefined) return loaded.index.truncated ? "unknown" : "missing-file"
  if (match.kind !== "open-file") return "unknown"
  let raw: unknown
  try {
    raw = await postTool(source, "get_basic_info", { fileId, pageId })
  } catch {
    return "unknown"
  }
  const catalog = parseArtboardCatalog(fileId, pageId, raw)
  if (catalog instanceof Fail) return "unknown"
  await commitFile(
    artboardsPath(cacheDirOf(source), fileId, pageId),
    textBytes(JSON.stringify(catalog)),
  )
  return catalog.artboards.some((item) => item.id === nodeId) ? "present" : "missing-artboard"
}

async function resolveCurrent(
  source: PaperSource,
  memory: PeekMemory,
): Promise<{ readonly memory: PeekMemory; readonly directive: DrawerDirective }> {
  if (memory.current === null) return { memory, directive: { kind: "projects", notice: "" } }
  const presence = await artboardPresence(source, memory.current)
  if (presence === "missing-artboard" || presence === "missing-file") {
    return {
      memory: forgetArtboard(memory, memory.current),
      directive: { kind: "projects", notice: GONE_NOTICE },
    }
  }
  return { memory, directive: { kind: "shot" } }
}

async function resolveFile(
  source: PaperSource,
  memory: PeekMemory,
  fileId: FileId,
): Promise<{ readonly memory: PeekMemory; readonly directive: DrawerDirective }> {
  const place = memory.byFile[fileId]
  if (place === undefined) return { memory, directive: { kind: "pages", fileId, notice: "" } }
  const presence = await artboardPresence(source, place)
  if (presence === "missing-file") {
    return {
      memory: forgetArtboard(memory, place),
      directive: { kind: "projects", notice: GONE_NOTICE },
    }
  }
  if (presence === "missing-artboard") {
    return {
      memory: forgetArtboard(memory, place),
      directive: { kind: "pages", fileId, notice: GONE_NOTICE },
    }
  }
  return { memory: remember(memory, place), directive: { kind: "shot" } }
}

function listedFiles(index: ProjectIndex): ListedFile[] {
  const folders = new Map<string, string>()
  for (const resource of index.resources) {
    if (resource.kind === "folder") folders.set(resource.id, resource.name)
  }
  const files: ListedFile[] = []
  for (const resource of index.resources) {
    if (resource.kind === "folder") continue
    files.push({
      id: resource.id,
      name: resource.name,
      folderId: resource.folder,
      folderName: resource.folder === null ? null : (folders.get(resource.folder) ?? resource.folder),
    })
  }
  return files
}

async function projectIndex(source: PaperSource, refresh: boolean): Promise<ProjectIndex | null> {
  if (!refresh) {
    const stored = await readProjects(source)
    if (stored.kind === "cached") return stored.index
  }
  const listed = await listProjects(source)
  if (listed.kind === "unavailable") return null
  return listed.index
}

async function browserPayload(
  source: PaperSource,
  command:
    | { readonly kind: "browser-projects"; readonly refresh: boolean }
    | { readonly kind: "browser-pages"; readonly fileId: FileId; readonly refresh: boolean }
    | {
        readonly kind: "browser-artboards"
        readonly fileId: FileId
        readonly pageId: PageId
        readonly refresh: boolean
      },
): Promise<{ readonly rows: readonly BrowserRow[] }> {
  if (command.kind === "browser-projects") {
    const index = await projectIndex(source, command.refresh)
    return { rows: projectRows(index === null ? [] : listedFiles(index), await readMemory()) }
  }
  if (command.kind === "browser-pages") {
    const listed = await listPages(source, command.fileId, command.refresh)
    if (listed.kind === "unavailable") return { rows: [] }
    return { rows: pageRows(command.fileId, listed.catalog.pages) }
  }
  const listed = await listArtboards(source, command.fileId, command.pageId, command.refresh)
  if (listed.kind === "unavailable") return { rows: [] }
  return { rows: artboardRows(command.fileId, command.pageId, listed.catalog.artboards) }
}

export async function run(argv: readonly string[], source: PaperSource): Promise<0 | 2 | 3> {
  const command = parseCommand(argv)
  if (command === "bad-args" || command === "bad-id") {
    process.stderr.write(`${command}\n`)
    return 3
  }
  if (command.kind === "status") {
    const status = await reportStatus(source, await readCurrentArtboardText())
    await publishStatus(status)
    process.stdout.write(`${status}\n`)
    return 0
  }
  if (command.kind === "projects") {
    const result = await listProjects(source)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.kind === "unavailable") {
      process.stderr.write(`${result.reason}\n`)
      return 2
    }
    return 0
  }
  if (command.kind === "shot") {
    const result = await fetchArtboard(source, { fileId: command.fileId, nodeId: command.nodeId })
    if (result.kind === "fresh") await logRefresh(`fetch ${command.fileId} ${command.nodeId}`)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.kind === "unavailable") {
      process.stderr.write(`${result.reason}\n`)
      return 2
    }
    return 0
  }
  if (command.kind === "watch") {
    const result = await watchArtboard(source, { fileId: command.fileId, nodeId: command.nodeId })
    await logRefresh(`check ${command.fileId} ${command.nodeId} ${result.kind}`)
    process.stdout.write(`${result.kind}\n`)
    return 0
  }
  if (command.kind === "resolve") {
    const resolved = await resolveCurrent(source, await readMemory())
    await writeMemory(resolved.memory)
    process.stdout.write(`${JSON.stringify(resolved.directive)}\n`)
    return 0
  }
  if (command.kind === "resolve-project") {
    const resolved = await resolveFile(source, await readMemory(), command.fileId)
    await writeMemory(resolved.memory)
    process.stdout.write(`${JSON.stringify(resolved.directive)}\n`)
    return 0
  }
  if (command.kind === "remember") {
    const place = await namesFor(source, command.fileId, command.pageId, command.nodeId)
    await writeMemory(remember(await readMemory(), place))
    process.stdout.write(`${JSON.stringify({ kind: "shot" })}\n`)
    return 0
  }
  if (
    command.kind === "browser-projects" ||
    command.kind === "browser-pages" ||
    command.kind === "browser-artboards"
  ) {
    process.stdout.write(`${JSON.stringify(await browserPayload(source, command))}\n`)
    return 0
  }
  if (command.kind === "pages") {
    return finishCatalog(await listPages(source, command.fileId, command.refresh))
  }
  return finishCatalog(
    await listArtboards(source, command.fileId, command.pageId, command.refresh),
  )
}

function finishCatalog(result: PageResult | ArtboardCatalogResult): 0 | 2 {
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.kind === "unavailable") {
    process.stderr.write(`${result.reason}\n`)
    return 2
  }
  return 0
}

function parseCommand(argv: readonly string[]): Command | "bad-args" | "bad-id" {
  if (argv.length === 1 && argv[0] === "status") return { kind: "status" }
  if (argv.length === 1 && argv[0] === "projects") return { kind: "projects" }
  if (argv[0] === "pages") return parsePages(argv)
  if (argv[0] === "artboards") return parseArtboards(argv)
  if (argv[0] === "shot") return parseShot(argv)
  if (argv[0] === "watch") return parseWatch(argv)
  if (argv.length === 1 && argv[0] === "resolve") return { kind: "resolve" }
  if (argv[0] === "resolve-project") return parseResolveProject(argv)
  if (argv[0] === "remember") return parseRemember(argv)
  if (argv[0] === "browser") return parseBrowser(argv)
  return "bad-args"
}

function parseResolveProject(argv: readonly string[]): Command | "bad-args" | "bad-id" {
  if (argv.length !== 2 || argv[1]!.startsWith("-")) return "bad-args"
  const fileId = parseFileId(argv[1]!)
  if (fileId === null) return "bad-id"
  return { kind: "resolve-project", fileId }
}

function parseRemember(argv: readonly string[]): Command | "bad-args" | "bad-id" {
  if (argv.length !== 4 || argv.slice(1).some((token) => token.startsWith("-"))) return "bad-args"
  const fileId = parseFileId(argv[1]!)
  const pageId = parsePageId(argv[2]!)
  const nodeId = parseNodeId(argv[3]!)
  if (fileId === null || pageId === null || nodeId === null) return "bad-id"
  return { kind: "remember", fileId, pageId, nodeId }
}

function parseBrowser(argv: readonly string[]): Command | "bad-args" | "bad-id" {
  const split = splitRefresh(argv)
  if (split === "bad-args" || split.args.length < 1) return "bad-args"
  const head = split.args[0]
  if (head === "projects" && split.args.length === 1) {
    return { kind: "browser-projects", refresh: split.refresh }
  }
  if (head === "pages" && split.args.length === 2) {
    const fileId = parseFileId(split.args[1]!)
    if (fileId === null) return "bad-id"
    return { kind: "browser-pages", fileId, refresh: split.refresh }
  }
  if (head === "artboards" && split.args.length === 3) {
    const fileId = parseFileId(split.args[1]!)
    const pageId = parsePageId(split.args[2]!)
    if (fileId === null || pageId === null) return "bad-id"
    return { kind: "browser-artboards", fileId, pageId, refresh: split.refresh }
  }
  return "bad-args"
}

function parseWatch(argv: readonly string[]): Command | "bad-args" | "bad-id" {
  if (argv.length !== 3 || argv[1]!.startsWith("-") || argv[2]!.startsWith("-")) return "bad-args"
  const fileId = parseFileId(argv[1]!)
  const nodeId = parseNodeId(argv[2]!)
  if (fileId === null || nodeId === null) return "bad-id"
  return { kind: "watch", fileId, nodeId }
}

function parsePages(argv: readonly string[]): Command | "bad-args" | "bad-id" {
  const split = splitRefresh(argv)
  if (split === "bad-args" || split.args.length !== 1) return "bad-args"
  const fileId = parseFileId(split.args[0]!)
  if (fileId === null) return "bad-id"
  return { kind: "pages", fileId, refresh: split.refresh }
}

function parseArtboards(argv: readonly string[]): Command | "bad-args" | "bad-id" {
  const split = splitRefresh(argv)
  if (split === "bad-args" || split.args.length !== 2) return "bad-args"
  const fileId = parseFileId(split.args[0]!)
  const pageId = parsePageId(split.args[1]!)
  if (fileId === null || pageId === null) return "bad-id"
  return { kind: "artboards", fileId, pageId, refresh: split.refresh }
}

function parseShot(argv: readonly string[]): Command | "bad-args" | "bad-id" {
  if (argv.length === 3 && !argv[1]!.startsWith("-") && !argv[2]!.startsWith("-")) {
    return shotCommand(argv[1]!, argv[2]!)
  }
  if (argv.length === 5) {
    const fileRaw = flagValue(argv, "--file")
    const nodeRaw = flagValue(argv, "--node")
    if (fileRaw === null || nodeRaw === null) return "bad-args"
    return shotCommand(fileRaw, nodeRaw)
  }
  return "bad-args"
}

function shotCommand(fileRaw: string, nodeRaw: string): Command | "bad-id" {
  const fileId = parseFileId(fileRaw)
  const nodeId = parseNodeId(nodeRaw)
  if (fileId === null || nodeId === null) return "bad-id"
  return { kind: "shot", fileId, nodeId }
}

function splitRefresh(
  argv: readonly string[],
): { readonly args: readonly string[]; readonly refresh: boolean } | "bad-args" {
  const args: string[] = []
  let refresh = false
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--refresh") {
      refresh = true
      continue
    }
    if (token.startsWith("-")) return "bad-args"
    args.push(token)
  }
  return { args, refresh }
}

async function main(argv: readonly string[]): Promise<0 | 2 | 3> {
  if (argv.length === 1 && argv[0] === "settings") {
    ensureSettingsDir()
    const report = loadSettings()
    writeWarnings(report.warnings)
    process.stdout.write(`${JSON.stringify(settingsPayload(report))}\n`)
    return 0
  }
  if (argv.length === 1 && argv[0] === "apply-hotkeys") {
    const extra = await installHotkeys(loadSettings().settings)
    writeWarnings(extra)
    process.stdout.write(`${JSON.stringify({ warnings: extra })}\n`)
    return 0
  }
  return run(argv, livePaper())
}

function writeWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) process.stderr.write(`paper-peek: ${warning}\n`)
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  if (index < 0) return null
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("-")) return null
  return value
}

const entry = process.argv[1]
const entryUrl = entry === undefined ? "" : pathToFileURL(realpathSync(entry)).href
if (entry !== undefined && import.meta.url === entryUrl) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code)
    },
    () => {
      process.exit(2)
    },
  )
}
