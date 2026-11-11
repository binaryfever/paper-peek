import { mkdir, rename, writeFile } from "node:fs/promises"
import { basename, dirname } from "node:path"

export async function commitFile(dest: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const temp = `${dest}.${process.pid}.tmp`
  await writeFile(temp, bytes)
  await rename(temp, dest)
}

export function tempOwnerPid(filename: string): number | "bare" | null {
  const name = basename(filename)
  if (!name.endsWith(".tmp")) return null
  const match = /^(.*)\.([0-9]+)\.tmp$/.exec(name)
  const digits = match?.[2]
  if (digits !== undefined) {
    const pid = Number(digits)
    if (Number.isSafeInteger(pid) && pid > 0 && String(pid) === digits) return pid
  }
  return "bare"
}
