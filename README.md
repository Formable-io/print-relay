# print-relay

Warehouse LAN agent that delivers FinishFlow print jobs to printers without drivers. One small
Node process on an always-on box; outbound HTTPS only.

```
Pulse / WMS ──► Backend print queue (print-jobs) ◄── poll every 2 s ── print-relay ──► printers on the LAN
                                                    report status ──►                 ZPL  → TCP 9100 (Zebra ZD421)
                                                    heartbeat 30 s ──►                PDF  → IPP 631  (A4 laser with native PDF)
```

Nothing here rasterises anything. The Backend renders ZPL for labels and PDF for pick lists and
delivery notes; the relay fetches the bytes and hands them to a printer that understands them.

## Printers this works with

| Job | Printer | Protocol in Pulse → Printers | Port |
| --- | --- | --- | --- |
| Bin, SKU, cart, tint-can labels | Zebra ZD421t / ZD421d (203 dpi, Ethernet) | `Raw TCP 9100 (ZPL)` | 9100 |
| Pick lists, delivery notes (A4) | Any LAN laser that lists **PDF** as a printer language and supports IPP, e.g. Brother HL‑L5210DN | `IPP (PDF)` | 631 |

Host-based (GDI) printers — most consumer inkjets and the cheap Brother HL‑L2xxx line — do not
render PDF themselves and will not work. Do not buy one.

Give every printer and the relay box a DHCP reservation; the Backend stores the IP.

## Install on the warehouse box

Any Linux box with Docker works. A fanless mini PC (N100 class) is more robust than a Raspberry
Pi with an SD card.

```bash
# The image lives in a private GHCR package: log in once with a GitHub PAT that has read:packages
# (or make the package public under GitHub → Formable-io → Packages and skip this).
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

mkdir -p ~/print-relay && cd ~/print-relay
curl -fsSLO https://raw.githubusercontent.com/Formable-io/print-relay/main/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/Formable-io/print-relay/main/.env.example -o .env
$EDITOR .env          # BACKEND_URL, PRINT_RELAY_API_KEY, RELAY_ID
docker compose up -d
docker compose logs -f print-relay
```

Watchtower (in the compose file) pulls new images every 5 minutes and restarts the relay, so a
merge to `main` here is a deploy. You never touch the box again.

`PRINT_RELAY_API_KEY` must equal the Backend's `PRINT_RELAY_API_KEY` (Vercel env).
Generate one with `openssl rand -hex 32`.

## How a job flows

1. `GET /api/wms/print/jobs/poll` — the Backend flips returned jobs to `processing` and increments `attempts`.
2. Bytes come inline in the poll response (ZPL as utf8, PDF ≤ 250 KB as base64) or are fetched from the artifact URL on Vercel Blob.
3. Delivery by printer protocol:
   - `raw_9100_zpl` → TCP connect, write, half-close.
   - `ipp_pdf` → IPP `Print-Job` with `document-format: application/pdf`, tried on each path in `IPP_PATHS` (`/ipp/print` is IPP Everywhere, `/ipp/port1` is Brother's legacy path). IPP 2.0 first, 1.1 if the printer insists.
4. `POST /api/wms/print/jobs/relay-status`:
   - `completed` with where it was sent (and the printer's own job id for IPP).
   - `failed` for anything a retry cannot fix: no IP on the printer, wrong protocol for the content, IPP `client-error-*`, expired artifact, no IPP endpoint found.
   - `processing` with the reason for transient trouble (printer off, timeout, `server-error-*`). The Backend requeues the job after ~2 minutes without a result, until `maxAttempts` (5) is used up, then fails it.
5. `POST /api/wms/print/relay/heartbeat` every 30 s. Pulse → Printers shows the relay as offline after 90 s of silence; jobs then sit in `queued` and the page says so.

Every step is visible on the job in the Backend admin (`print-jobs` → relayEvents) and in `wms-events`.

## Configuration

See [`.env.example`](.env.example). `IPP_RAW_FALLBACK` writes the PDF bytes to port 9100 when no
IPP endpoint answers; leave it off unless the printer is known to render PDF natively.

## Development

```bash
pnpm install
cp .env.example .env     # point BACKEND_URL at http://localhost:3000 with the Backend running
pnpm dev                 # tsx watch
pnpm test                # node:test via tsx
pnpm typecheck
```

The IPP client is hand-rolled (RFC 8010/8011 Print-Job only) so the runtime has zero
dependencies; `src/ipp.test.ts` covers the wire format.

## Security

- Outbound only. No inbound ports, no VPN, no cloud-to-LAN tunnel.
- The relay key is a shared secret that grants poll/report/heartbeat and nothing else; rotate it in Vercel and `.env` together.
- The container runs as the unprivileged `node` user and has no volumes besides Watchtower's Docker socket.
