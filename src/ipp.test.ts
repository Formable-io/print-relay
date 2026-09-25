import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IPP_OPERATION_PRINT_JOB,
  IPP_TAG,
  decodeIppResponse,
  encodePrintJobRequest,
  ippStatusText,
  isIppClientError,
  isIppSuccess,
  readIppInteger,
  readIppText,
} from './ipp.ts'

const attribute = (tag: number, name: string, value: Buffer): Buffer => {
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(3)
  head.writeUInt8(tag, 0)
  head.writeUInt16BE(nameBuf.byteLength, 1)
  const len = Buffer.alloc(2)
  len.writeUInt16BE(value.byteLength, 0)
  return Buffer.concat([head, nameBuf, len, value])
}

test('encodes a Print-Job request with header, operation attributes, and the document last', () => {
  const document = Buffer.from('%PDF-1.7\n%%EOF\n')
  const request = encodePrintJobRequest({
    printerUri: 'ipp://192.168.1.60:631/ipp/print',
    jobName: 'PJ-000042',
    documentFormat: 'application/pdf',
    requestingUserName: 'finishflow-print-relay/koege',
    requestId: 7,
    version: '2.0',
    document,
  })

  assert.equal(request.readUInt8(0), 2)
  assert.equal(request.readUInt8(1), 0)
  assert.equal(request.readUInt16BE(2), IPP_OPERATION_PRINT_JOB)
  assert.equal(request.readInt32BE(4), 7)
  assert.equal(request.readUInt8(8), IPP_TAG.operationAttributes)

  const text = request.toString('latin1')
  for (const expected of [
    'attributes-charset',
    'utf-8',
    'attributes-natural-language',
    'printer-uri',
    'ipp://192.168.1.60:631/ipp/print',
    'job-name',
    'PJ-000042',
    'document-format',
    'application/pdf',
  ]) {
    assert.ok(text.includes(expected), `request should contain ${expected}`)
  }

  const endTag = request.byteLength - document.byteLength - 1
  assert.equal(request.readUInt8(endTag), IPP_TAG.end)
  assert.ok(request.subarray(endTag + 1).equals(document))
})

test('IPP 1.1 is encoded when requested', () => {
  const request = encodePrintJobRequest({
    printerUri: 'ipp://p:631/ipp/print',
    jobName: 'x',
    documentFormat: 'application/pdf',
    requestingUserName: 'relay',
    requestId: 1,
    version: '1.1',
    document: Buffer.alloc(0),
  })
  assert.equal(request.readUInt8(0), 1)
  assert.equal(request.readUInt8(1), 1)
})

test('decodes a successful response with job-id and status-message', () => {
  const header = Buffer.alloc(8)
  header.writeUInt8(2, 0)
  header.writeUInt8(0, 1)
  header.writeUInt16BE(0x0000, 2)
  header.writeInt32BE(7, 4)
  const jobId = Buffer.alloc(4)
  jobId.writeInt32BE(123, 0)
  const body = Buffer.concat([
    header,
    Buffer.from([IPP_TAG.operationAttributes]),
    attribute(IPP_TAG.charset, 'attributes-charset', Buffer.from('utf-8')),
    attribute(IPP_TAG.text, 'status-message', Buffer.from('successful-ok')),
    Buffer.from([IPP_TAG.jobAttributes]),
    attribute(IPP_TAG.integer, 'job-id', jobId),
    attribute(IPP_TAG.uri, 'job-uri', Buffer.from('ipp://p/jobs/123')),
    Buffer.from([IPP_TAG.end]),
  ])

  const response = decodeIppResponse(body)
  assert.equal(response.version, '2.0')
  assert.equal(response.statusCode, 0)
  assert.equal(response.requestId, 7)
  assert.equal(readIppInteger(response, 'job-id'), 123)
  assert.equal(readIppText(response, 'status-message'), 'successful-ok')
  assert.ok(isIppSuccess(response.statusCode))
})

test('additional values with an empty name attach to the previous attribute', () => {
  const header = Buffer.alloc(8)
  header.writeUInt8(2, 0)
  header.writeUInt16BE(0x040a, 2)
  const body = Buffer.concat([
    header,
    Buffer.from([IPP_TAG.operationAttributes]),
    attribute(IPP_TAG.mimeMediaType, 'document-format-supported', Buffer.from('application/pdf')),
    attribute(IPP_TAG.mimeMediaType, '', Buffer.from('application/postscript')),
    Buffer.from([IPP_TAG.end]),
  ])
  const response = decodeIppResponse(body)
  const formats = response.attributes.get('document-format-supported')
  assert.deepEqual(
    formats?.values.map((value) => value.toString()),
    ['application/pdf', 'application/postscript'],
  )
  assert.ok(isIppClientError(response.statusCode))
  assert.equal(ippStatusText(response.statusCode), 'client-error-document-format-not-supported')
})

test('unknown status codes render as hex', () => {
  assert.equal(ippStatusText(0x0777), '0x0777')
})
