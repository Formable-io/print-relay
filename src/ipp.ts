import http from 'node:http'

/**
 * Minimal IPP (RFC 8010/8011) Print-Job client. Only what a driverless PDF
 * hand-off needs: one operation, a handful of operation attributes, and enough
 * response parsing to surface `status-message` and `job-id`.
 */

export const IPP_OPERATION_PRINT_JOB = 0x0002

export const IPP_TAG = {
  operationAttributes: 0x01,
  jobAttributes: 0x02,
  end: 0x03,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  text: 0x41,
  name: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
} as const

export type IppVersion = '2.0' | '1.1'

export type IppAttribute = { tag: number; name: string; values: Buffer[] }

export type IppResponse = {
  version: IppVersion | string
  statusCode: number
  requestId: number
  attributes: Map<string, IppAttribute>
}

const encodeAttribute = (tag: number, name: string, value: string | number): Buffer => {
  const nameBuf = Buffer.from(name, 'utf8')
  let valueBuf: Buffer
  if (typeof value === 'number') {
    valueBuf = Buffer.alloc(4)
    valueBuf.writeInt32BE(value, 0)
  } else {
    valueBuf = Buffer.from(value, 'utf8')
  }
  const out = Buffer.alloc(1 + 2 + nameBuf.byteLength + 2 + valueBuf.byteLength)
  let offset = 0
  out.writeUInt8(tag, offset)
  offset += 1
  out.writeUInt16BE(nameBuf.byteLength, offset)
  offset += 2
  nameBuf.copy(out, offset)
  offset += nameBuf.byteLength
  out.writeUInt16BE(valueBuf.byteLength, offset)
  offset += 2
  valueBuf.copy(out, offset)
  return out
}

export type PrintJobRequest = {
  printerUri: string
  jobName: string
  documentFormat: string
  requestingUserName: string
  requestId: number
  version: IppVersion
  document: Buffer
}

export const encodePrintJobRequest = (input: PrintJobRequest): Buffer => {
  const header = Buffer.alloc(8)
  const [major, minor] = input.version === '2.0' ? [2, 0] : [1, 1]
  header.writeUInt8(major, 0)
  header.writeUInt8(minor, 1)
  header.writeUInt16BE(IPP_OPERATION_PRINT_JOB, 2)
  header.writeInt32BE(input.requestId, 4)

  return Buffer.concat([
    header,
    Buffer.from([IPP_TAG.operationAttributes]),
    encodeAttribute(IPP_TAG.charset, 'attributes-charset', 'utf-8'),
    encodeAttribute(IPP_TAG.naturalLanguage, 'attributes-natural-language', 'en'),
    encodeAttribute(IPP_TAG.uri, 'printer-uri', input.printerUri),
    encodeAttribute(IPP_TAG.name, 'requesting-user-name', input.requestingUserName),
    encodeAttribute(IPP_TAG.name, 'job-name', input.jobName),
    encodeAttribute(IPP_TAG.mimeMediaType, 'document-format', input.documentFormat),
    Buffer.from([IPP_TAG.end]),
    input.document,
  ])
}

export const decodeIppResponse = (buffer: Buffer): IppResponse => {
  if (buffer.byteLength < 9) throw new Error(`IPP response too short (${buffer.byteLength} bytes)`)
  const version = `${buffer.readUInt8(0)}.${buffer.readUInt8(1)}`
  const statusCode = buffer.readUInt16BE(2)
  const requestId = buffer.readInt32BE(4)
  const attributes = new Map<string, IppAttribute>()

  let offset = 8
  let lastName: string | null = null
  while (offset < buffer.byteLength) {
    const tag = buffer.readUInt8(offset)
    if (tag === IPP_TAG.end) break
    if (tag < 0x10) {
      // Attribute-group delimiter (operation, job, printer, ...).
      offset += 1
      lastName = null
      continue
    }
    if (offset + 3 > buffer.byteLength) break
    const nameLength = buffer.readUInt16BE(offset + 1)
    const nameStart = offset + 3
    const nameEnd = nameStart + nameLength
    if (nameEnd + 2 > buffer.byteLength) break
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8')
    const valueLength = buffer.readUInt16BE(nameEnd)
    const valueStart = nameEnd + 2
    const valueEnd = valueStart + valueLength
    if (valueEnd > buffer.byteLength) break
    const value = Buffer.from(buffer.subarray(valueStart, valueEnd))

    const key: string | null = nameLength === 0 ? lastName : name
    if (key) {
      const existing = attributes.get(key)
      if (existing) existing.values.push(value)
      else attributes.set(key, { tag, name: key, values: [value] })
      lastName = key
    }
    offset = valueEnd
  }

  return { version, statusCode, requestId, attributes }
}

export const ippStatusText = (statusCode: number): string => {
  const known: Record<number, string> = {
    0x0000: 'successful-ok',
    0x0001: 'successful-ok-ignored-or-substituted-attributes',
    0x0002: 'successful-ok-conflicting-attributes',
    0x0400: 'client-error-bad-request',
    0x0401: 'client-error-forbidden',
    0x0402: 'client-error-not-authenticated',
    0x0403: 'client-error-not-authorized',
    0x0404: 'client-error-not-possible',
    0x0405: 'client-error-timeout',
    0x0406: 'client-error-not-found',
    0x0407: 'client-error-gone',
    0x0408: 'client-error-request-entity-too-large',
    0x0409: 'client-error-request-value-too-long',
    0x040a: 'client-error-document-format-not-supported',
    0x040b: 'client-error-attributes-or-values-not-supported',
    0x040c: 'client-error-uri-scheme-not-supported',
    0x040d: 'client-error-charset-not-supported',
    0x040e: 'client-error-conflicting-attributes',
    0x0500: 'server-error-internal-error',
    0x0501: 'server-error-operation-not-supported',
    0x0502: 'server-error-service-unavailable',
    0x0503: 'server-error-version-not-supported',
    0x0504: 'server-error-device-error',
    0x0505: 'server-error-temporary-error',
    0x0506: 'server-error-not-accepting-jobs',
    0x0507: 'server-error-busy',
    0x0508: 'server-error-job-canceled',
  }
  return known[statusCode] || `0x${statusCode.toString(16).padStart(4, '0')}`
}

export const isIppSuccess = (statusCode: number): boolean => statusCode <= 0x00ff
export const isIppClientError = (statusCode: number): boolean => statusCode >= 0x0400 && statusCode <= 0x04ff
export const isIppVersionNotSupported = (statusCode: number): boolean => statusCode === 0x0503

export const readIppText = (response: IppResponse, name: string): string | null => {
  const attribute = response.attributes.get(name)
  const first = attribute?.values[0]
  return first ? first.toString('utf8') : null
}

export const readIppInteger = (response: IppResponse, name: string): number | null => {
  const attribute = response.attributes.get(name)
  const first = attribute?.values[0]
  return first && first.byteLength === 4 ? first.readInt32BE(0) : null
}

export type IppHttpResult = { httpStatus: number; body: Buffer }

/** POST an IPP request body to the printer and collect the raw response. */
export const postIpp = (
  host: string,
  port: number,
  path: string,
  request: Buffer,
  timeoutMs: number,
): Promise<IppHttpResult> =>
  new Promise<IppHttpResult>((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/ipp',
          'content-length': request.byteLength,
          expect: '100-continue',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ httpStatus: res.statusCode || 0, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs} ms talking IPP to ${host}:${port}${path}`)))
    req.on('error', reject)
    // Send the body once the printer says 100-continue, or straight away if it doesn't bother.
    let sent = false
    const send = () => {
      if (sent) return
      sent = true
      req.end(request)
    }
    req.on('continue', send)
    setTimeout(send, 1000).unref()
  })
