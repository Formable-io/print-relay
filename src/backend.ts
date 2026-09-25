import type { RelayConfig } from './config.ts'

export type PolledPrinter = {
  id: string | null
  name: string | null
  protocol: string | null
  ip: string | null
  port: number | null
}

export type PolledJob = {
  id: string
  code: string
  jobType: string | null
  status: string
  contentType: 'zpl' | 'pdf' | 'html' | null
  printer: PolledPrinter | null
  artifactUrl: string | null
  payload: {
    inlineBody?: string | null
    inlineEncoding?: 'utf8' | 'base64' | null
    [key: string]: unknown
  } | null
}

export type ReportStatus = 'processing' | 'completed' | 'failed'

const REQUEST_TIMEOUT_MS = 15_000

export class BackendClient {
  private readonly headers: Record<string, string>

  constructor(private readonly config: RelayConfig) {
    this.headers = {
      'x-print-relay-key': config.apiKey,
      accept: 'application/json',
      'user-agent': `finishflow-print-relay/${config.version} (${config.relayId})`,
    }
  }

  async pollJobs(): Promise<PolledJob[]> {
    const url = `${this.config.backendUrl}/api/wms/print/jobs/poll?limit=${this.config.pollLimit}`
    const body = await this.request<{ success: boolean; data?: PolledJob[] }>(url, { method: 'GET' })
    return Array.isArray(body.data) ? body.data : []
  }

  async reportStatus(printJobId: string, status: ReportStatus, message?: string): Promise<void> {
    await this.request(`${this.config.backendUrl}/api/wms/print/jobs/relay-status`, {
      method: 'POST',
      body: JSON.stringify({ printJobId, status, message, relayId: this.config.relayId }),
    })
  }

  async heartbeat(): Promise<void> {
    await this.request(`${this.config.backendUrl}/api/wms/print/relay/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        relayId: this.config.relayId,
        version: this.config.version,
        hostname: this.config.hostname,
      }),
    })
  }

  private async request<T = unknown>(url: string, init: { method: string; body?: string }): Promise<T> {
    const response = await fetch(url, {
      method: init.method,
      headers: init.body ? { ...this.headers, 'content-type': 'application/json' } : this.headers,
      body: init.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Backend ${init.method} ${new URL(url).pathname} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Backend ${init.method} ${new URL(url).pathname} returned non-JSON: ${text.slice(0, 120)}`)
    }
  }
}
