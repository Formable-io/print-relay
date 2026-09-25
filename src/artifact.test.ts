import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveJobBytes, type FetchLike } from './artifact.ts'
import type { PolledJob } from './backend.ts'
import { PermanentPrintError } from './errors.ts'

const job = (overrides: Partial<PolledJob>): PolledJob => ({
  id: 'j',
  code: 'PJ-000009',
  jobType: 'delivery_note',
  status: 'processing',
  contentType: 'pdf',
  printer: null,
  artifactUrl: null,
  payload: null,
  ...overrides,
})

const neverFetch: FetchLike = async () => {
  throw new Error('fetch should not be called')
}

test('inline ZPL is used as-is', async () => {
  const bytes = await resolveJobBytes(job({ payload: { inlineBody: '^XA^XZ', inlineEncoding: 'utf8' } }), neverFetch)
  assert.equal(bytes.toString('utf8'), '^XA^XZ')
})

test('inline PDF is base64-decoded', async () => {
  const pdf = Buffer.from('%PDF-1.7')
  const bytes = await resolveJobBytes(
    job({ payload: { inlineBody: pdf.toString('base64'), inlineEncoding: 'base64' } }),
    neverFetch,
  )
  assert.ok(bytes.equals(pdf))
})

test('large artifacts are downloaded from the artifact URL', async () => {
  const pdf = Buffer.from('%PDF-1.7 big')
  const fetchImpl: FetchLike = async (url) => {
    assert.equal(url, 'https://blob.test/a.pdf')
    return new Response(pdf, { status: 200 })
  }
  const bytes = await resolveJobBytes(job({ artifactUrl: 'https://blob.test/a.pdf' }), fetchImpl)
  assert.ok(bytes.equals(pdf))
})

test('expired artifacts fail permanently, other download errors are transient', async () => {
  const gone: FetchLike = async () => new Response(null, { status: 404 })
  await assert.rejects(resolveJobBytes(job({ artifactUrl: 'https://blob.test/x.pdf' }), gone), PermanentPrintError)

  const flaky: FetchLike = async () => new Response('nope', { status: 503 })
  await assert.rejects(
    resolveJobBytes(job({ artifactUrl: 'https://blob.test/x.pdf' }), flaky),
    (error: unknown) => error instanceof Error && !(error instanceof PermanentPrintError),
  )
})

test('a job with nothing to print fails permanently', async () => {
  await assert.rejects(resolveJobBytes(job({}), neverFetch), PermanentPrintError)
})
