import { readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export type RelayConfig = {
  backendUrl: string
  apiKey: string
  relayId: string
  hostname: string
  version: string
  pollIntervalMs: number
  pollLimit: number
  heartbeatIntervalMs: number
  sendTimeoutMs: number
  ippPaths: string[]
  ippRawFallback: boolean
  logLevel: LogLevel
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const readEnv = (name: string): string | undefined => {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const requireEnv = (name: string): string => {
  const value = readEnv(name)
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

const envInt = (name: string, fallback: number, min: number): number => {
  const raw = readEnv(name)
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`)
  return Math.max(min, parsed)
}

const envBool = (name: string, fallback: boolean): boolean => {
  const raw = readEnv(name)
  if (!raw) return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

const envLogLevel = (): LogLevel => {
  const raw = (readEnv('LOG_LEVEL') || 'info').toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  throw new Error(`LOG_LEVEL must be debug|info|warn|error, got "${raw}"`)
}

const packageVersion = (): string => {
  try {
    const url = new URL('../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export const loadConfig = (): RelayConfig => {
  const backendUrl = requireEnv('BACKEND_URL').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(backendUrl)) {
    throw new Error(`BACKEND_URL must start with http:// or https://, got "${backendUrl}"`)
  }

  return {
    backendUrl,
    apiKey: requireEnv('PRINT_RELAY_API_KEY'),
    relayId: readEnv('RELAY_ID') || os.hostname(),
    hostname: os.hostname(),
    version: readEnv('RELAY_VERSION') || packageVersion(),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 2000, 500),
    pollLimit: envInt('POLL_LIMIT', 5, 1),
    heartbeatIntervalMs: envInt('HEARTBEAT_INTERVAL_MS', 30_000, 5_000),
    sendTimeoutMs: envInt('SEND_TIMEOUT_MS', 30_000, 1_000),
    ippPaths: (readEnv('IPP_PATHS') || '/ipp/print,/ipp/port1')
      .split(',')
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => (path.startsWith('/') ? path : `/${path}`)),
    ippRawFallback: envBool('IPP_RAW_FALLBACK', false),
    logLevel: envLogLevel(),
  }
}
