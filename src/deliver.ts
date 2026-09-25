import type { PolledJob } from './backend.ts'
import type { RelayConfig } from './config.ts'
import { PermanentPrintError } from './errors.ts'
import {
  decodeIppResponse,
  encodePrintJobRequest,
  ippStatusText,
  isIppClientError,
  isIppSuccess,
  isIppVersionNotSupported,
  postIpp,
  readIppInteger,
  readIppText,
  type IppVersion,
} from './ipp.ts'
import { sendRaw } from './raw9100.ts'

export type DeliveryPlan =
  | { kind: 'raw'; host: string; port: number; printerName: string }
  | { kind: 'ipp'; host: string; port: number; printerName: string }

const RAW_DEFAULT_PORT = 9100
const IPP_DEFAULT_PORT = 631

/**
 * Decide how a polled job reaches its printer. Pure, so the routing rules are
 * unit-testable without sockets. Throws `PermanentPrintError` for anything a
 * retry cannot fix.
 */
export const planDelivery = (job: PolledJob): DeliveryPlan => {
  const printer = job.printer
  if (!printer) throw new PermanentPrintError(`Job ${job.code} has no printer assigned.`)

  const printerName = printer.name || printer.id || 'unknown printer'
  const host = printer.ip?.trim()
  if (!host) throw new PermanentPrintError(`Printer "${printerName}" has no IP / host configured.`)

  switch (printer.protocol) {
    case 'raw_9100_zpl':
      if (job.contentType && job.contentType !== 'zpl') {
        throw new PermanentPrintError(
          `Printer "${printerName}" speaks ZPL over TCP 9100 but job ${job.code} is ${job.contentType}.`,
        )
      }
      return { kind: 'raw', host, port: printer.port || RAW_DEFAULT_PORT, printerName }
    case 'ipp_pdf':
      if (job.contentType && job.contentType !== 'pdf') {
        throw new PermanentPrintError(
          `Printer "${printerName}" is an IPP PDF printer but job ${job.code} is ${job.contentType}.`,
        )
      }
      return { kind: 'ipp', host, port: printer.port || IPP_DEFAULT_PORT, printerName }
    case 'pdf_relay':
      throw new PermanentPrintError(
        `Printer "${printerName}" uses the retired "pdf_relay" protocol. Re-save it as "ipp_pdf" in Pulse → Printers.`,
      )
    default:
      throw new PermanentPrintError(
        `Printer "${printerName}" has unsupported protocol "${printer.protocol ?? 'none'}".`,
      )
  }
}

export type Senders = {
  sendRaw: typeof sendRaw
  postIpp: typeof postIpp
}

const defaultSenders: Senders = { sendRaw, postIpp }

let requestCounter = Math.floor(Math.random() * 0x0fff_ffff) + 1
const nextRequestId = (): number => {
  requestCounter = requestCounter >= 0x7fff_fff0 ? 1 : requestCounter + 1
  return requestCounter
}

/** Send the bytes according to the plan. Resolves with a human-readable detail for the job log. */
export const deliver = async (
  plan: DeliveryPlan,
  job: PolledJob,
  bytes: Buffer,
  config: RelayConfig,
  senders: Senders = defaultSenders,
): Promise<string> => {
  if (plan.kind === 'raw') {
    await senders.sendRaw(plan.host, plan.port, bytes, config.sendTimeoutMs)
    return `Sent ${bytes.byteLength} bytes to ${plan.printerName} (${plan.host}:${plan.port}, raw).`
  }

  const attempted: string[] = []
  for (const path of config.ippPaths) {
    const printerUri = `ipp://${plan.host}:${plan.port}${path}`
    let version: IppVersion = '2.0'

    for (let round = 0; round < 2; round += 1) {
      const request = encodePrintJobRequest({
        printerUri,
        jobName: job.code,
        documentFormat: 'application/pdf',
        requestingUserName: `finishflow-print-relay/${config.relayId}`,
        requestId: nextRequestId(),
        version,
        document: bytes,
      })

      const result = await senders.postIpp(plan.host, plan.port, path, request, config.sendTimeoutMs)

      if (result.httpStatus === 404) {
        attempted.push(`${path} (HTTP 404)`)
        break
      }
      if (result.httpStatus < 200 || result.httpStatus >= 300) {
        throw new Error(`IPP endpoint ${printerUri} answered HTTP ${result.httpStatus}.`)
      }

      const response = decodeIppResponse(result.body)
      if (isIppSuccess(response.statusCode)) {
        const jobId = readIppInteger(response, 'job-id')
        return `Submitted ${bytes.byteLength} bytes to ${plan.printerName} via ${printerUri}${
          jobId !== null ? ` (printer job ${jobId})` : ''
        }.`
      }

      const status = ippStatusText(response.statusCode)
      const message = readIppText(response, 'status-message')
      const detail = `${status}${message ? `: ${message}` : ''}`

      if (isIppVersionNotSupported(response.statusCode) && version === '2.0') {
        version = '1.1'
        continue
      }
      if (response.statusCode === 0x0406) {
        // client-error-not-found: wrong path on this printer, try the next one.
        attempted.push(`${path} (${detail})`)
        break
      }
      if (isIppClientError(response.statusCode)) {
        throw new PermanentPrintError(`${plan.printerName} rejected job ${job.code}: ${detail}`)
      }
      throw new Error(`${plan.printerName} could not take job ${job.code} right now: ${detail}`)
    }
  }

  if (config.ippRawFallback) {
    await senders.sendRaw(plan.host, RAW_DEFAULT_PORT, bytes, config.sendTimeoutMs)
    return `No IPP endpoint on ${plan.printerName} (tried ${attempted.join(', ')}); sent ${bytes.byteLength} bytes raw to ${plan.host}:${RAW_DEFAULT_PORT}.`
  }

  throw new PermanentPrintError(
    `No IPP endpoint found on ${plan.printerName} at ${plan.host}:${plan.port} (tried ${attempted.join(', ') || 'nothing'}). Check IPP_PATHS or the printer's IPP settings.`,
  )
}
