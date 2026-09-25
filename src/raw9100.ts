import net from 'node:net'

/**
 * Raw socket printing: connect, write the bytes, half-close. Resolves once the
 * data has been flushed to the printer — Zebra printers print on receipt and
 * do not acknowledge, so a flushed write is the strongest signal available.
 */
export const sendRaw = (host: string, port: number, data: Buffer, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }

    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs} ms sending ${data.byteLength} bytes to ${host}:${port}`))
    }, timeoutMs)

    socket.once('error', (error) => finish(error))
    socket.once('connect', () => {
      socket.end(data, () => finish())
    })
  })
