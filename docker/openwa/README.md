# OpenWA — self-hosted WhatsApp gateway for CHFR

OpenWA runs as a **separate service** from the CHFR web app. It drives a headless
browser session against WhatsApp Web, which means it needs more memory than the
web app and, critically, **durable storage for its session state**.

> OpenWA publishes no image to a registry, so it is built from source. Clone it
> next to this project:
>
> ```bash
> git clone https://github.com/rmyndharis/OpenWA.git ../OpenWA
> ```

## Why a separate service

- **Session persistence.** The paired WhatsApp session lives on disk. If that
  storage is ephemeral, every restart or deploy logs the CHFR number out and
  someone has to re-scan the QR code on the phone. Render's default filesystem
  *is* ephemeral, so OpenWA needs a service with a persistent disk attached.
- **Memory.** A headless Chromium needs roughly 1 GB. Bundling it into the web
  service would make every booking page share that footprint.
- **Blast radius.** WhatsApp is the one integration that can be logged out
  remotely, from the phone, by someone who is not you. Keeping it separate means
  that never touches the booking database.

## Local

```bash
# from the project root
docker compose --profile whatsapp up -d --build
```

The compose file mounts a named volume at `/app/data` for session state, and
deliberately does **not** publish port 2785 to the host — only the `web`
service, on the private compose network, can reach it.

## On Render

Create a **private service** (not a web service — it must not be reachable from
the internet):

| Setting | Value |
| --- | --- |
| Type | Private Service |
| Runtime | Docker |
| Repository | your fork/clone of `rmyndharis/OpenWA` |
| Region | same region as `chfr-ldn` |
| Plan | Standard or above (needs ~1 GB RAM for Chromium) |
| **Disk** | **Required.** Mount at `/app/data`, 1 GB is plenty |
| Env: `API_KEY` | a long random string — generate with `openssl rand -hex 32` |
| Env: `PORT` | `2785` |

Then set these on the **`chfr-ldn` web service**:

```
WHATSAPP_ENABLED=true
OPENWA_BASE_URL=http://<render-private-service-name>:2785
OPENWA_API_KEY=<the same API_KEY>
OPENWA_SESSION_ID=CHFR
CHFR_WHATSAPP_NUMBER=+44…
```

`OPENWA_BASE_URL` uses Render's internal hostname, so the traffic never leaves
their private network. **Do not** give OpenWA a public URL.

## Pairing the phone

1. Sign in to `/admin/whatsapp` on the CHFR dashboard.
2. Press **Connect** — this creates and starts the `CHFR` session.
3. Press **Refresh QR**.
4. On the CHFR phone: WhatsApp → **Settings → Linked devices → Link a device**,
   and scan the code.
5. The status turns **CONNECTED**. Press **Send test message** to confirm.

The QR code is fetched by the CHFR backend and rendered into the page — the
OpenWA URL and API key never reach the browser.

## Operational notes

- **Use a dedicated business number.** Unofficial WhatsApp clients carry a real
  risk of the number being restricted or banned. Do not pair a personal phone.
- **WhatsApp is best-effort.** If the session drops, bookings are still saved,
  emailed and exported. The WhatsApp notification is marked `FAILED` and can be
  re-sent from the booking page with **Send WhatsApp again**.
- **Backing up the session** is not necessary; re-pairing takes under a minute.
  The database is what must be backed up.
