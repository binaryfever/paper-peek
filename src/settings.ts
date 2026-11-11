import { execFile } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type DrawerSide = "left" | "right"
export type PeekMode = "drawer" | "dock"

export type Settings = {
  readonly toggleHotkey: string
  readonly browserHotkey: string
  readonly drawerSide: DrawerSide
  readonly drawerWidth: number
  readonly refreshIntervalMs: number
  readonly defaultMode: PeekMode
  readonly paperAddress: string
  readonly cacheBudgetMb: number
}

export type SettingsSource = "absent" | "file"

export type SettingsReport = {
  readonly source: SettingsSource
  readonly settings: Settings
  readonly paperUrl: string
  readonly warnings: readonly string[]
}

export type SettingsPayload = {
  readonly source: SettingsSource
  readonly toggleHotkey: string
  readonly browserHotkey: string
  readonly drawerSide: DrawerSide
  readonly drawerWidth: number
  readonly refreshIntervalMs: number
  readonly defaultMode: PeekMode
  readonly paperAddress: string
  readonly cacheBudgetMb: number
  readonly paperUrl: string
  readonly warnings: readonly string[]
}

export type LiveHotkey = {
  readonly modmask: number
  readonly key: string
  readonly description: string
}

export type HotkeyBind = {
  readonly chord: string
  readonly description: string
  readonly command: string
}

export type HotkeyPlan = {
  readonly unbind: readonly string[]
  readonly bind: readonly HotkeyBind[]
  readonly warnings: readonly string[]
}

const SETTING_KEYS = [
  "toggleHotkey",
  "browserHotkey",
  "drawerSide",
  "drawerWidth",
  "refreshIntervalMs",
  "defaultMode",
  "paperAddress",
  "cacheBudgetMb",
] as const

type _SettingsListCovers<T extends true> = T
type _EverySettingIsListed = _SettingsListCovers<
  Exclude<keyof Settings, (typeof SETTING_KEYS)[number]> extends never ? true : false
>
type _PayloadCopiesEverySetting = _SettingsListCovers<
  Exclude<keyof Settings, keyof SettingsPayload> extends never ? true : false
>

const MOD_BITS: Readonly<Record<string, number>> = {
  SUPER: 64,
  ALT: 8,
  CTRL: 4,
  SHIFT: 1,
}
const MOD_ORDER = ["SUPER", "ALT", "CTRL", "SHIFT"] as const
const KNOWN_MODS = 64 | 8 | 4 | 1
const KEY_TEXT = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|SPACE|RETURN|ESCAPE|TAB|UP|DOWN|LEFT|RIGHT)$/
const ADDRESS_TEXT = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/

const WIDTH_MIN = 240
const WIDTH_MAX = 1200
const INTERVAL_MIN = 500
const INTERVAL_MAX = 60_000
const BUDGET_MIN = 0
const BUDGET_MAX = 2 ** 20

export const TOGGLE_DESCRIPTION = "Toggle Paper Peek"
export const BROWSER_DESCRIPTION = "Open Paper Peek browser"
export const TOGGLE_COMMAND = "omarchy-shell binaryfever.paper-peek toggle"
export const BROWSER_COMMAND = "omarchy-shell binaryfever.paper-peek browser"

export const DEFAULT_SETTINGS: Settings = {
  toggleHotkey: "SUPER + SHIFT + H",
  browserHotkey: "",
  drawerSide: "right",
  drawerWidth: 480,
  refreshIntervalMs: 2000,
  defaultMode: "drawer",
  paperAddress: "127.0.0.1:29979",
  cacheBudgetMb: 200,
}

export function settingsFilePath(): string {
  const override = process.env.PAPER_PEEK_SETTINGS
  if (override !== undefined && override !== "") return override
  const configHome = process.env.XDG_CONFIG_HOME
  const root = configHome !== undefined && configHome !== "" ? configHome : join(homedir(), ".config")
  return join(root, "paper-peek", "settings.json")
}

export function ensureSettingsDir(): void {
  mkdirSync(dirname(settingsFilePath()), { recursive: true })
}

export function loadSettings(): SettingsReport {
  const path = settingsFilePath()
  try {
    return parseSettings(readFileSync(path, "utf8"))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return report(DEFAULT_SETTINGS, [], "absent")
    return report(DEFAULT_SETTINGS, [`settings file could not be read, using defaults`], "absent")
  }
}

export function parseSettings(text: string): SettingsReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return report(DEFAULT_SETTINGS, ["settings file is not json, using defaults"], "file")
  }
  if (!isRecord(parsed)) {
    return report(DEFAULT_SETTINGS, ["settings file must be a json object, using defaults"], "file")
  }
  const warnings: string[] = []
  for (const key of Object.keys(parsed)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      warnings.push(`unknown setting ${JSON.stringify(key)}, ignoring it`)
    }
  }
  const settings: Settings = {
    toggleHotkey: takeHotkey(parsed, "toggleHotkey", DEFAULT_SETTINGS.toggleHotkey, false, warnings),
    browserHotkey: takeHotkey(parsed, "browserHotkey", "", true, warnings),
    drawerSide: takeSide(parsed, warnings),
    drawerWidth: takeInt(parsed, "drawerWidth", DEFAULT_SETTINGS.drawerWidth, WIDTH_MIN, WIDTH_MAX, warnings),
    refreshIntervalMs: takeInt(
      parsed,
      "refreshIntervalMs",
      DEFAULT_SETTINGS.refreshIntervalMs,
      INTERVAL_MIN,
      INTERVAL_MAX,
      warnings,
    ),
    defaultMode: takeMode(parsed, warnings),
    paperAddress: takeAddress(parsed, warnings),
    cacheBudgetMb: takeInt(parsed, "cacheBudgetMb", DEFAULT_SETTINGS.cacheBudgetMb, BUDGET_MIN, BUDGET_MAX, warnings),
  }
  return report(settings, warnings, "file")
}

export function settingsPayload(report: SettingsReport): SettingsPayload {
  return {
    source: report.source,
    toggleHotkey: report.settings.toggleHotkey,
    browserHotkey: report.settings.browserHotkey,
    drawerSide: report.settings.drawerSide,
    drawerWidth: report.settings.drawerWidth,
    refreshIntervalMs: report.settings.refreshIntervalMs,
    defaultMode: report.settings.defaultMode,
    paperAddress: report.settings.paperAddress,
    cacheBudgetMb: report.settings.cacheBudgetMb,
    paperUrl: report.paperUrl,
    warnings: report.warnings,
  }
}

export function configuredPaperUrl(explicit?: string): string {
  if (explicit !== undefined && explicit !== "") return explicit
  const env = process.env.PAPER_MCP_URL
  if (env !== undefined && env !== "") return env
  return loadSettings().paperUrl
}

export function parseChord(
  raw: string,
): { readonly modmask: number; readonly key: string; readonly canonical: string } | null {
  const parts = raw
    .split("+")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== "")
  if (parts.length < 2) return null
  const key = parts[parts.length - 1]
  if (key === undefined || !KEY_TEXT.test(key)) return null
  let mask = 0
  const seen = new Set<string>()
  for (const mod of parts.slice(0, -1)) {
    const bit = MOD_BITS[mod]
    if (bit === undefined || seen.has(mod)) return null
    seen.add(mod)
    mask |= bit
  }
  const ordered = MOD_ORDER.filter((name) => seen.has(name))
  return { modmask: mask, key, canonical: [...ordered, key].join(" + ") }
}

export function planHotkeys(settings: Settings, live: readonly LiveHotkey[]): HotkeyPlan {
  const warnings: string[] = []
  const unbind: string[] = []
  const bind: HotkeyBind[] = []
  planAction(TOGGLE_DESCRIPTION, TOGGLE_COMMAND, settings.toggleHotkey, live, warnings, unbind, bind)
  const browser =
    settings.browserHotkey !== "" && settings.browserHotkey === settings.toggleHotkey
      ? blockedBrowser(warnings)
      : settings.browserHotkey
  planAction(
    BROWSER_DESCRIPTION,
    BROWSER_COMMAND,
    browser === "" ? null : browser,
    live,
    warnings,
    unbind,
    bind,
  )
  return { unbind: unique(unbind), bind, warnings }
}

export function hotkeyEval(plan: HotkeyPlan): readonly string[] {
  return [
    ...plan.unbind.map((chord) => `hl.unbind(${luaString(chord)})`),
    ...plan.bind.map(
      (action) =>
        `o.bind(${luaString(action.chord)}, ${luaString(action.description)}, ${luaString(action.command)})`,
    ),
  ]
}

export function parseLiveBinds(text: string): LiveHotkey[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const live: LiveHotkey[] = []
  for (const item of parsed) {
    const bind = liveHotkey(item)
    if (bind !== null) live.push(bind)
  }
  return live
}

export async function installHotkeys(settings: Settings): Promise<readonly string[]> {
  let raw: string
  try {
    raw = await hyprctl(["binds", "-j"])
  } catch {
    return ["hotkeys were not changed because hyprctl binds failed"]
  }
  const live = parseLiveBinds(raw)
  if (live === null) return ["hotkeys were not changed because hyprctl binds was not json"]
  const plan = planHotkeys(settings, live)
  const warnings = [...plan.warnings]
  for (const code of hotkeyEval(plan)) {
    try {
      const stdout = await hyprctl(["eval", code])
      if (!stdout.trim().startsWith("ok")) warnings.push(`hyprctl rejected ${code}`)
    } catch {
      warnings.push(`hyprctl failed on ${code}`)
    }
  }
  return warnings
}

function blockedBrowser(warnings: string[]): "" {
  warnings.push("browser hotkey matches the toggle hotkey, leaving the browser unbound")
  return ""
}

function planAction(
  description: string,
  command: string,
  chord: string | null,
  live: readonly LiveHotkey[],
  warnings: string[],
  unbind: string[],
  bind: HotkeyBind[],
): void {
  const ours = live.filter((item) => item.description === description)
  if (chord === null) {
    for (const item of ours) {
      const current = chordFromBind(item)
      if (current !== null) unbind.push(current)
    }
    return
  }
  const parsed = parseChord(chord)
  if (parsed === null) return
  const occupant = live.find(
    (item) =>
      item.description !== description && item.modmask === parsed.modmask && item.key === parsed.key,
  )
  if (occupant !== undefined) {
    warnings.push(`${description} hotkey ${parsed.canonical} is already used by ${occupant.description}`)
    return
  }
  const onKey = ours.filter((item) => item.modmask === parsed.modmask && item.key === parsed.key)
  for (const item of ours) {
    if (onKey.length === 1 && onKey[0] === item) continue
    const current = chordFromBind(item)
    if (current !== null) unbind.push(current)
  }
  if (onKey.length !== 1) bind.push({ chord: parsed.canonical, description, command })
}

function chordFromBind(bind: LiveHotkey): string | null {
  if ((bind.modmask & ~KNOWN_MODS) !== 0) return null
  const mods = MOD_ORDER.filter((name) => (bind.modmask & MOD_BITS[name]) !== 0)
  if (mods.length === 0 || !KEY_TEXT.test(bind.key)) return null
  return [...mods, bind.key].join(" + ")
}

function liveHotkey(value: unknown): LiveHotkey | null {
  if (!isRecord(value)) return null
  if (value.mouse === true) return null
  if (typeof value.modmask !== "number" || typeof value.key !== "string") return null
  if (typeof value.description !== "string" || value.description === "") return null
  const key = value.key.toUpperCase()
  if (key.startsWith("MOUSE")) return null
  return { modmask: value.modmask, key, description: value.description }
}

async function hyprctl(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("hyprctl", [...args], { encoding: "utf8" })
  return stdout
}

function luaString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function report(settings: Settings, warnings: readonly string[], source: SettingsSource): SettingsReport {
  return {
    source,
    settings,
    paperUrl: `http://${settings.paperAddress}/mcp`,
    warnings,
  }
}

function takeHotkey(
  record: Record<string, unknown>,
  key: "toggleHotkey" | "browserHotkey",
  fallback: string,
  allowEmpty: boolean,
  warnings: string[],
): string {
  if (!(key in record)) return fallback
  const value = record[key]
  if (typeof value !== "string") {
    warnings.push(invalid(key, value, hotkeyFallback(fallback)))
    return fallback
  }
  const trimmed = value.trim()
  if (trimmed === "") {
    if (allowEmpty) return ""
    warnings.push(invalid(key, value, hotkeyFallback(fallback)))
    return fallback
  }
  const parsed = parseChord(trimmed)
  if (parsed === null) {
    warnings.push(invalid(key, value, hotkeyFallback(fallback)))
    return fallback
  }
  return parsed.canonical
}

function takeSide(record: Record<string, unknown>, warnings: string[]): DrawerSide {
  if (!("drawerSide" in record)) return DEFAULT_SETTINGS.drawerSide
  const value = record.drawerSide
  if (value === "left" || value === "right") return value
  warnings.push(invalid("drawerSide", value, DEFAULT_SETTINGS.drawerSide))
  return DEFAULT_SETTINGS.drawerSide
}

function takeMode(record: Record<string, unknown>, warnings: string[]): PeekMode {
  if (!("defaultMode" in record)) return DEFAULT_SETTINGS.defaultMode
  const value = record.defaultMode
  if (value === "drawer" || value === "dock") return value
  warnings.push(invalid("defaultMode", value, DEFAULT_SETTINGS.defaultMode))
  return DEFAULT_SETTINGS.defaultMode
}

function takeAddress(record: Record<string, unknown>, warnings: string[]): string {
  if (!("paperAddress" in record)) return DEFAULT_SETTINGS.paperAddress
  const value = record.paperAddress
  if (typeof value === "string" && validAddress(value)) return value
  warnings.push(invalid("paperAddress", value, DEFAULT_SETTINGS.paperAddress))
  return DEFAULT_SETTINGS.paperAddress
}

function takeInt(
  record: Record<string, unknown>,
  key: "drawerWidth" | "refreshIntervalMs" | "cacheBudgetMb",
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  if (!(key in record)) return fallback
  const value = record[key]
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    warnings.push(invalid(key, value, String(fallback)))
    return fallback
  }
  return value
}

function validAddress(value: string): boolean {
  const match = ADDRESS_TEXT.exec(value)
  if (match === null) return false
  const port = Number(match[2])
  return port >= 1 && port <= 65535
}

function invalid(key: string, value: unknown, fallback: string): string {
  return `${key} ${JSON.stringify(value)} is invalid, using ${fallback}`
}

function hotkeyFallback(fallback: string): string {
  return fallback === "" ? "no hotkey" : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
