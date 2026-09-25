import assert from 'node:assert/strict'
import test from 'node:test'

import type { PolledJob } from './backend.ts'
import type { RelayConfig } from './config.ts'
import { deliver, planDelivery, type Senders } from './deliver.ts'
import { PermanentPrintError } from './errors.ts'
import { IPP_TAG } from './ipp.ts'

const baseJob = (overrides: Partial<PolledJob> = {}): PolledJob => ({
  id: 'job-1',
  code: 'PJ-000001',
  jobType: 'bin_label',
  status: 'processing',
  contentType: 'zpl',
  printer: { id: 'p1', name: 'Warehouse ZD421t', protocol: 'raw_9100_zpl', ip: '192.168.1.50', port: 9100 },
  artifactUrl: null,
  payload: { inlineBody: '^XA^XZ', inlineEncoding: 'utf8' },
  ...overrides,
})

const config: RelayConfig = {
  backendUrl: 'https://backend.test',
  apiKey: 'k',
  relayId: 'test-relay',
  hostname: 'box',
  version: '0.0.0',
  pollIntervalMs: 2000,
  pollLimit: 5,
  heartbeatIntervalMs: 30000,
  sendTimeoutMs: 1000,
  ippPaths: ['/ipp/print', '/ipp/port1'],
  ippRawFallback: false,
  logLevel: 'error',
}

const ippResponse = (statusCode: number, jobId?: number): Buffer => {
  const header = Buffer.alloc(8)
  header.writeUInt8(2, 0)
  header.writeUInt16BE(statusCode, 2)
  header.writeInt32BE(1, 4)
  const parts = [header, Buffer.from([IPP_TAG.operationAttributes])]
  if (jobId !== undefined) {
    const name = Buffer.from('job-id')
    const head = Buffer.alloc(3)
    head.writeUInt8(IPP_TAG.integer, 0)
    head.writeUInt16BE(name.byteLength, 1)
    const len = Buffer.alloc(2)
    len.writeUInt16BE(4, 0)
    const value = Buffer.alloc(4)
    value.writeInt32BE(jobId, 0)
    parts.push(Buffer.from([IPP_TAG.jobAttributes]), head, name, len, value)
  }
  parts.push(Buffer.from([IPP_TAG.end]))
  return Buffer.concat(parts)
}

test('ZPL jobs route to raw TCP on the printer port', () => {
  const plan = planDelivery(baseJob())
  assert.deepEqual(plan, { kind: 'raw', host: '192.168.1.50', port: 9100, printerName: 'Warehouse ZD421t' })
})

test('PDF jobs route to IPP, defaulting to port 631', () => {
  const plan = planDelivery(
    baseJob({
      contentType: 'pdf',
      printer: { id: 'p2', name: 'Brother A4', protocol: 'ipp_pdf', ip: '192.168.1.60', port: null },
    }),
  )
  assert.deepEqual(plan, { kind: 'ipp', host: '192.168.1.60', port: 631, printerName: 'Brother A4' })
})

test('misconfiguration is permanent: no printer, no IP, wrong content type, retired protocol', () => {
  assert.throws(() => planDelivery(baseJob({ printer: null })), PermanentPrintError)
  assert.throws(
    () => planDelivery(baseJob({ printer: { ...baseJob().printer!, ip: '  ' } })),
    PermanentPrintError,
  )
  assert.throws(() => planDelivery(baseJob({ contentType: 'pdf' })), /is pdf/)
  assert.throws(
    () => planDelivery(baseJob({ printer: { ...baseJob().printer!, protocol: 'pdf_relay' } })),
    /retired "pdf_relay"/,
  )
})

test('raw delivery writes the bytes once and reports the target', async () => {
  const calls: Array<{ host: string; port: number; size: number }> = []
  const senders: Senders = {
    sendRaw: async (host, port, data) => {
      calls.push({ host, port, size: data.byteLength })
    },
    postIpp: async () => {
      throw new Error('should not be called')
    },
  }
  const detail = await deliver(planDelivery(baseJob()), baseJob(), Buffer.from('^XA^XZ'), config, senders)
  assert.deepEqual(calls, [{ host: '192.168.1.50', port: 9100, size: 6 }])
  assert.match(detail, /192\.168\.1\.50:9100, raw/)
})

test('IPP delivery falls through 404 paths and succeeds on the next one', async () => {
  const paths: string[] = []
  const senders: Senders = {
    sendRaw: async () => {
      throw new Error('should not be called')
    },
    postIpp: async (_host, _port, path) => {
      paths.push(path)
      if (path === '/ipp/print') return { httpStatus: 404, body: Buffer.alloc(0) }
      return { httpStatus: 200, body: ippResponse(0x0000, 42) }
    },
  }
  const job = baseJob({
    contentType: 'pdf',
    printer: { id: 'p2', name: 'Brother A4', protocol: 'ipp_pdf', ip: '192.168.1.60', port: 631 },
  })
  const detail = await deliver(planDelivery(job), job, Buffer.from('%PDF'), config, senders)
  assert.deepEqual(paths, ['/ipp/print', '/ipp/port1'])
  assert.match(detail, /ipp:\/\/192\.168\.1\.60:631\/ipp\/port1 \(printer job 42\)/)
})

test('IPP version-not-supported retries the same path with 1.1', async () => {
  const versions: number[] = []
  const senders: Senders = {
    sendRaw: async () => {
      throw new Error('should not be called')
    },
    postIpp: async (_host, _port, _path, request) => {
      versions.push(request.readUInt8(0))
      return versions.length === 1
        ? { httpStatus: 200, body: ippResponse(0x0503) }
        : { httpStatus: 200, body: ippResponse(0x0000) }
    },
  }
  const job = baseJob({
    contentType: 'pdf',
    printer: { id: 'p2', name: 'Brother A4', protocol: 'ipp_pdf', ip: '192.168.1.60', port: 631 },
  })
  await deliver(planDelivery(job), job, Buffer.from('%PDF'), config, senders)
  assert.deepEqual(versions, [2, 1])
})

test('IPP client errors are permanent, server errors are transient', async () => {
  const job = baseJob({
    contentType: 'pdf',
    printer: { id: 'p2', name: 'Brother A4', protocol: 'ipp_pdf', ip: '192.168.1.60', port: 631 },
  })
  const withStatus = (statusCode: number): Senders => ({
    sendRaw: async () => {
      throw new Error('should not be called')
    },
    postIpp: async () => ({ httpStatus: 200, body: ippResponse(statusCode) }),
  })

  await assert.rejects(
    deliver(planDelivery(job), job, Buffer.from('%PDF'), config, withStatus(0x040a)),
    PermanentPrintError,
  )
  await assert.rejects(
    deliver(planDelivery(job), job, Buffer.from('%PDF'), config, withStatus(0x0506)),
    (error: unknown) => error instanceof Error && !(error instanceof PermanentPrintError),
  )
})

test('no IPP endpoint at all is permanent unless the raw fallback is enabled', async () => {
  const job = baseJob({
    contentType: 'pdf',
    printer: { id: 'p2', name: 'Brother A4', protocol: 'ipp_pdf', ip: '192.168.1.60', port: 631 },
  })
  let rawCalls = 0
  const senders: Senders = {
    sendRaw: async () => {
      rawCalls += 1
    },
    postIpp: async () => ({ httpStatus: 404, body: Buffer.alloc(0) }),
  }

  await assert.rejects(deliver(planDelivery(job), job, Buffer.from('%PDF'), config, senders), PermanentPrintError)
  assert.equal(rawCalls, 0)

  const detail = await deliver(planDelivery(job), job, Buffer.from('%PDF'), { ...config, ippRawFallback: true }, senders)
  assert.equal(rawCalls, 1)
  assert.match(detail, /raw to 192\.168\.1\.60:9100/)
})
