import type { LogLevel } from './config.ts'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type Logger = {
  debug: (message: string, fields?: Record<string, unknown>) => void
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
  error: (message: string, fields?: Record<string, unknown>) => void
}

/** One JSON line per event, so `docker logs` stays greppable. */
export const createLogger = (level: LogLevel): Logger => {
  const threshold = ORDER[level]
  const emit = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[entryLevel] < threshold) return
    const line = JSON.stringify({ time: new Date().toISOString(), level: entryLevel, message, ...fields })
    if (entryLevel === 'error' || entryLevel === 'warn') process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
  }
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  }
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
