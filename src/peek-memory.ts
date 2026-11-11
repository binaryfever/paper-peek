import { homedir } from "node:os"
import { join } from "node:path"

const ID_TEXT = /^[A-Za-z0-9_-]+$/

export const RECENT_LIMIT = 5
export const GONE_NOTICE = "That artboard is gone."

export type ArtboardPlace = {
  readonly fileId: string
  readonly pageId: string
  readonly nodeId: string
  readonly projectName: string
  readonly pageName: string
  readonly artboardName: string
}

export type PeekMemory = {
  readonly current: ArtboardPlace | null
  readonly byFile: Readonly<Record<string, ArtboardPlace>>
  readonly recent: readonly ArtboardPlace[]
}

export type ListedFile = {
  readonly id: string
  readonly name: string
  readonly folderId: string | null
  readonly folderName: string | null
}

export type BrowserRow =
  | { readonly kind: "header"; readonly label: string }
  | {
      readonly kind: "recent"
      readonly label: string
      readonly detail: string
      readonly fileId: string
      readonly pageId: string
      readonly nodeId: string
    }
  | { readonly kind: "project"; readonly label: string; readonly fileId: string }
  | { readonly kind: "page"; readonly label: string; readonly fileId: string; readonly pageId: string }
  | {
      readonly kind: "artboard"
      readonly label: string
      readonly fileId: string
      readonly pageId: string
      readonly nodeId: string
    }

export function memoryFilePath(): string {
  const override = process.env.PAPER_PEEK_STATE
  if (override !== undefined && override !== "") return override
  const stateHome = process.env.XDG_STATE_HOME
  const root = stateHome !== undefined && stateHome !== "" ? stateHome : join(homedir(), ".local", "state")
  return join(root, "paper-peek", "current.json")
}

export function emptyMemory(): PeekMemory {
  return { current: null, byFile: {}, recent: [] }
}

export function sameArtboard(a: ArtboardPlace, b: ArtboardPlace): boolean {
  return a.fileId === b.fileId && a.pageId === b.pageId && a.nodeId === b.nodeId
}

export function remember(memory: PeekMemory, place: ArtboardPlace): PeekMemory {
  const recent = [place, ...memory.recent.filter((item) => !sameArtboard(item, place))].slice(
    0,
    RECENT_LIMIT,
  )
  return {
    current: place,
    byFile: { ...memory.byFile, [place.fileId]: place },
    recent,
  }
}

export function forgetArtboard(memory: PeekMemory, place: ArtboardPlace): PeekMemory {
  const byFile = { ...memory.byFile }
  const slot = byFile[place.fileId]
  if (slot !== undefined && sameArtboard(slot, place)) delete byFile[place.fileId]
  const current =
    memory.current !== null && sameArtboard(memory.current, place) ? null : memory.current
  return {
    current,
    byFile,
    recent: memory.recent.filter((item) => !sameArtboard(item, place)),
  }
}

export function parseMemory(text: string): PeekMemory {
  if (text.trim() === "") return emptyMemory()
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return emptyMemory()
  }
  if (!isRecord(parsed)) return emptyMemory()
  const current = placeFrom(parsed)
  const byFile = parseByFile(parsed.byFile)
  const recent = Array.isArray(parsed.recent) ? capRecent(parsed.recent.map(placeFrom)) : null
  const withFile = { ...byFile }
  if (current !== null && withFile[current.fileId] === undefined) withFile[current.fileId] = current
  return {
    current,
    byFile: withFile,
    recent: recent ?? (current !== null ? [current] : []),
  }
}

export function memoryText(memory: PeekMemory): string {
  const current = memory.current
  const byFile: Record<string, ReturnType<typeof placeDocument>> = {}
  for (const key of Object.keys(memory.byFile).sort()) {
    const place = memory.byFile[key]
    if (place !== undefined) byFile[key] = placeDocument(place)
  }
  return `${JSON.stringify(
    {
      fileId: current?.fileId ?? "",
      pageId: current?.pageId ?? "",
      nodeId: current?.nodeId ?? "",
      projectName: current?.projectName ?? "",
      pageName: current?.pageName ?? "",
      artboardName: current?.artboardName ?? "",
      byFile,
      recent: memory.recent.map(placeDocument),
    },
    null,
    2,
  )}\n`
}

export function projectRows(files: readonly ListedFile[], memory: PeekMemory): BrowserRow[] {
  const rows: BrowserRow[] = []
  if (memory.recent.length > 0) {
    rows.push({ kind: "header", label: "Recent" })
    for (const place of memory.recent) {
      rows.push({
        kind: "recent",
        label: place.artboardName !== "" ? place.artboardName : place.nodeId,
        detail: place.projectName !== "" ? place.projectName : place.fileId,
        fileId: place.fileId,
        pageId: place.pageId,
        nodeId: place.nodeId,
      })
    }
  }
  const groups = new Map<string, { readonly title: string | null; readonly files: ListedFile[] }>()
  for (const file of files) {
    const key = file.folderId ?? ""
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { title: file.folderName, files: [file] })
      continue
    }
    existing.files.push(file)
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const aNamed = a.title !== null && a.title !== ""
    const bNamed = b.title !== null && b.title !== ""
    if (aNamed !== bNamed) return aNamed ? -1 : 1
    return (a.title ?? "").localeCompare(b.title ?? "")
  })
  const named = ordered.filter((group) => group.title !== null && group.title !== "")
  const untitled = ordered.filter((group) => group.title === null || group.title === "")
  const pushFiles = (group: { readonly files: readonly ListedFile[] }): void => {
    const sorted = [...group.files].sort((a, b) => a.name.localeCompare(b.name))
    for (const file of sorted) rows.push({ kind: "project", label: file.name, fileId: file.id })
  }
  if (named.length === 0) {
    rows.push({ kind: "header", label: "Projects" })
    for (const group of untitled) pushFiles(group)
    return rows
  }
  for (const group of named) {
    rows.push({ kind: "header", label: group.title ?? "" })
    pushFiles(group)
  }
  if (untitled.length > 0) {
    rows.push({ kind: "header", label: "Other" })
    for (const group of untitled) pushFiles(group)
  }
  return rows
}

export function pageRows(
  fileId: string,
  pages: readonly { readonly id: string; readonly name: string }[],
): BrowserRow[] {
  return pages.map((page) => ({
    kind: "page" as const,
    label: page.name,
    fileId,
    pageId: page.id,
  }))
}

export function artboardRows(
  fileId: string,
  pageId: string,
  artboards: readonly { readonly id: string; readonly name: string }[],
): BrowserRow[] {
  return artboards.map((artboard) => ({
    kind: "artboard" as const,
    label: artboard.name,
    fileId,
    pageId,
    nodeId: artboard.id,
  }))
}

function placeDocument(place: ArtboardPlace): {
  fileId: string
  pageId: string
  nodeId: string
  projectName: string
  pageName: string
  artboardName: string
} {
  return {
    fileId: place.fileId,
    pageId: place.pageId,
    nodeId: place.nodeId,
    projectName: place.projectName,
    pageName: place.pageName,
    artboardName: place.artboardName,
  }
}

function parseByFile(value: unknown): Record<string, ArtboardPlace> {
  if (!isRecord(value)) return {}
  const byFile: Record<string, ArtboardPlace> = {}
  for (const key of Object.keys(value)) {
    const place = placeFrom(value[key])
    if (place === null || place.fileId !== key) continue
    byFile[key] = place
  }
  return byFile
}

function capRecent(places: readonly (ArtboardPlace | null)[]): ArtboardPlace[] {
  const recent: ArtboardPlace[] = []
  for (const place of places) {
    if (place === null || recent.some((item) => sameArtboard(item, place))) continue
    recent.push(place)
    if (recent.length === RECENT_LIMIT) break
  }
  return recent
}

function placeFrom(value: unknown): ArtboardPlace | null {
  if (!isRecord(value)) return null
  if (typeof value.fileId !== "string" || typeof value.pageId !== "string" || typeof value.nodeId !== "string") {
    return null
  }
  if (!ID_TEXT.test(value.fileId) || !ID_TEXT.test(value.pageId) || !ID_TEXT.test(value.nodeId)) return null
  return {
    fileId: value.fileId,
    pageId: value.pageId,
    nodeId: value.nodeId,
    projectName: typeof value.projectName === "string" ? value.projectName : "",
    pageName: typeof value.pageName === "string" ? value.pageName : "",
    artboardName: typeof value.artboardName === "string" ? value.artboardName : "",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
