import type { PolledJob } from './backend.ts'
import { PermanentPrintError } from './errors.ts'

const ARTIFACT_TIMEOUT_MS = 30_000

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/**
 * Bytes to send to the printer. Small artifacts travel inline in the poll
 * response (ZPL as utf8, PDF as base64); larger ones are fetched from the
 * artifact URL the Backend stored on Vercel Blob.
 */
export const resolveJobBytes = async (job: PolledJob, fetchImpl: FetchLike = fetch): Promise<Buffer> => {
  const inline = job.payload?.inlineBody
  if (typeof inline === 'string' && inline.length > 0) {
    const encoding = job.payload?.inlineEncoding === 'base64' ? 'base64' : 'utf8'
    return Buffer.from(inline, encoding)
  }

  if (!job.artifactUrl) {
    throw new PermanentPrintError(`Job ${job.code} has neither an inline body nor an artifact URL.`)
  }

  const response = await fetchImpl(job.artifactUrl, { signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS) })
  if (response.status === 404 || response.status === 410) {
    throw new PermanentPrintError(`Artifact for job ${job.code} is gone (HTTP ${response.status}); it has expired.`)
  }
  if (!response.ok) {
    throw new Error(`Artifact download for job ${job.code} failed with HTTP ${response.status}.`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new PermanentPrintError(`Artifact for job ${job.code} is empty.`)
  }
  return bytes
}
