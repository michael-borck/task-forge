# Task Forge

A small kickoff helper for the **keep-asking** study (HREC 83897). A co-investigator
uploads an existing worksheet (or pastes a rough idea), and the tool returns 2–3
concrete **AI-assisted lab task designs** in the study's approved format — scenario,
brief, deliverable, a 1–5 rubric, the 2–4 *load-bearing specifics* a generic AI answer
would miss, and an honest pre-pilot checklist. It can also **stress-test a task you
already have** and refit it. You can then iterate ("make option 2 harder; add a
conflicting stakeholder") and download each design as Markdown matching
`docs/task-design-template.md`.

It exists because the hardest part of the kickoff ask is exactly this: designing a task
where *challenging the AI pays off*. The tool is itself a little dialogue-over-delegation
exercise — you converse with the model to sharpen the task.

## Privacy model

- **Files are parsed in the browser** (`mammoth` for `.docx`, `pdf.js` for `.pdf`). The
  raw file never leaves your computer — only the extracted text is sent.
- The server is a **stateless proxy**: it holds the Anthropic API key, forwards the
  request, returns the result, and **stores nothing** (no database, no disk writes).
- Extracted text is sent only to the Anthropic API, with provider training opt-out
  recommended on your account.

## Run locally

```bash
cp .env.example .env        # add ANTHROPIC_API_KEY and an ACCESS_CODE
npm install
npm start                   # http://localhost:8080
```

## Deploy on a VPS (Docker)

Images are built and pushed to GHCR by GitHub Actions on every push to `main`
(`.github/workflows/docker-image.yml`). On the VPS you only need `docker-compose.yml`
and a `.env` file:

```bash
# one-time
cp .env.example .env        # fill in real values

# each release
docker compose pull
docker compose up -d
```

Put a reverse proxy (Caddy/nginx/Traefik) in front for HTTPS; the container listens on
`:8080`. The first VPS pull from GHCR may need `docker login ghcr.io` if the package is
private.

## Configuration (`.env`)

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Required.** Held server-side only. | — |
| `ACCESS_CODE` | Shared passphrase; blank = fully open. | — |
| `MODEL` | Quality generation model. | `claude-sonnet-4-6` |
| `FAST_MODEL` | "Fast/cheap mode" for quick iteration. | `claude-haiku-4-5` |
| `MAX_REQUESTS_PER_DAY` | Per-visitor-IP request cap. | `100` |
| `DAILY_TOKEN_CAP` | Global output-token ceiling/day (then 503). | `2000000` |
| `MAX_INPUT_CHARS` | Reject oversized source text. | `60000` |
| `PORT` | Listen port. | `8080` |

## Security notes

- **No login by design**, gated by a shared `ACCESS_CODE` plus per-IP and daily-token
  caps. This is appropriate for a small team over a short window — it is **not**
  hardened multi-tenant auth. Don't widely advertise the URL.
- The access code is cached in the visitor's browser `localStorage` after first entry.
- The rate/spend guards are in-memory and reset on container restart.

## What it is not

Generated task designs are **drafts for the team to review and sign off** before
piloting. The tool encodes the study's design rules but does not replace investigator
judgement or the ethics process.
