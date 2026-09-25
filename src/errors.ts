/**
 * A failure that retrying will not fix: misconfigured printer, unsupported
 * document format, missing artifact. The relay reports these as `failed`.
 *
 * Everything else (printer off, cable out, timeout, 5xx) is transient: the
 * relay reports `processing` with the reason and lets the Backend requeue the
 * job after its stale window, until `maxAttempts` is used up.
 */
export class PermanentPrintError extends Error {
  override readonly name = 'PermanentPrintError'
}

export const isPermanent = (error: unknown): error is PermanentPrintError =>
  error instanceof PermanentPrintError
