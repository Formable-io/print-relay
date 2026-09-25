import { resolveJobBytes } from './artifact.ts'
import { BackendClient, type PolledJob } from './backend.ts'
import { loadConfig } from './config.ts'
import { deliver, planDelivery } from './deliver.ts'
import { isPermanent } from './errors.ts'
import { createLogger, errorMessage } from './logger.ts'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const main = async (): Promise<void> => {
  const config = loadConfig()
  const log = createLogger(config.logLevel)
  const backend = new BackendClient(config)

  log.info('print relay starting', {
    relayId: config.relayId,
    version: config.version,
    backendUrl: config.backendUrl,
    pollIntervalMs: config.pollIntervalMs,
    ippPaths: config.ippPaths,
    ippRawFallback: config.ippRawFallback,
  })

  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    log.info('print relay stopping', { signal })
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  const heartbeat = async () => {
    try {
      await backend.heartbeat()
      log.debug('heartbeat sent')
    } catch (error) {
      log.warn('heartbeat failed', { error: errorMessage(error) })
    }
  }
  await heartbeat()
  const heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatIntervalMs)

  const handleJob = async (job: PolledJob) => {
    const started = Date.now()
    const fields = { job: job.code, jobType: job.jobType, printer: job.printer?.name ?? null }
    try {
      const plan = planDelivery(job)
      const bytes = await resolveJobBytes(job)
      const detail = await deliver(plan, job, bytes, config)
      await backend.reportStatus(job.id, 'completed', detail)
      log.info('job printed', { ...fields, ms: Date.now() - started, detail })
    } catch (error) {
      const message = errorMessage(error)
      if (isPermanent(error)) {
        log.error('job failed permanently', { ...fields, error: message })
        await backend.reportStatus(job.id, 'failed', message).catch((reportError) =>
          log.error('could not report failure', { ...fields, error: errorMessage(reportError) }),
        )
        return
      }
      // Transient: leave the job in `processing` with the reason. The Backend
      // requeues it after its stale window until maxAttempts is used up.
      log.warn('job delivery failed, will retry', { ...fields, error: message })
      await backend
        .reportStatus(job.id, 'processing', `${message} — will retry.`)
        .catch((reportError) =>
          log.error('could not report transient failure', { ...fields, error: errorMessage(reportError) }),
        )
    }
  }

  let backendDown = false
  while (!stopping) {
    try {
      const jobs = await backend.pollJobs()
      if (backendDown) {
        backendDown = false
        log.info('backend reachable again')
      }
      for (const job of jobs) {
        if (stopping) break
        await handleJob(job)
      }
    } catch (error) {
      if (!backendDown) {
        backendDown = true
        log.warn('poll failed', { error: errorMessage(error) })
      } else {
        log.debug('poll still failing', { error: errorMessage(error) })
      }
    }
    await sleep(config.pollIntervalMs)
  }

  clearInterval(heartbeatTimer)
  log.info('print relay stopped')
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'error', message: 'print relay crashed', error: errorMessage(error) })}\n`)
  process.exit(1)
})
