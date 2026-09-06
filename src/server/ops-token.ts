import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The default data dir is ~/.nodeterm-server, so production lands this at the designed path. */
export const OPS_TOKEN_FILE = 'ops-token'

function readToken(file: string): string {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Operator token path is not a regular file: ${file}`)
  }
  const token = fs.readFileSync(file, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
    throw new Error(`Operator token file is empty or invalid: ${file}`)
  }
  // A copied/restored file may have arrived with a permissive mode. Authentication material is
  // useful only if it is private, so every boot repairs the mode rather than merely documenting it.
  fs.chmodSync(file, 0o600)
  return token
}

/**
 * Load the restart-stable operator bearer, creating it exactly once when absent.
 *
 * `wx` is the race boundary: two server boots cannot each invent a token and let the later writer
 * silently replace the one an operator already read. The loser reads the winner's file.
 */
export function loadOrCreateOpsToken(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      const token = randomBytes(32).toString('base64url')
      fs.writeFileSync(fd, `${token}\n`, 'utf8')
      fs.fsyncSync(fd)
      fs.chmodSync(file, 0o600)
      return token
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    return readToken(file)
  }
}

/** Constant-time bearer comparison. Browser cookies and the operator password never enter here. */
export function opsBearerMatches(
  authorization: string | string[] | undefined,
  expected: string
): boolean {
  if (typeof authorization !== 'string') return false
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  if (!match) return false
  const supplied = Buffer.from(match[1], 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted)
}
