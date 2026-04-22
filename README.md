# OpenProducer

A self-hosted broadcast production suite for live shows — graphics overlays, teleprompter, OBS control, and AI-assisted script and media generation. Built with Node.js, Express, and Socket.IO. Inspired by [h2r.graphics](https://h2r.graphics/).

## Features

### Graphics & Output
- **Graphic types** — Lower Thirds, Messages, Tickers, Agendas, Images, Image Galleries, Timers, Scoreboards
- **Transparent 1920×1080 output** for OBS/vMix browser sources
- **Multiview** — Preview (cued) and Program (live) monitors side-by-side, with camera source picker
- **Cue system** — stage graphics in Preview, fire with Run
- **Card-based rundown** with inline editing, drag-and-drop reorder, and per-card color coding
- **Variables** — `[text.1]`, `[list1.1]` syntax for dynamic data
- **Theme editor** — primary/secondary colors, fonts, custom CSS
- **Layouts** — bundle an OBS scene with a set of overlay graphics and switch with one action

### Teleprompter
- Full-screen teleprompter view plus a flow/rehearsal view
- Scripts composed of labeled steps with per-step actions (show/hide/update graphics, switch layouts, OBS commands, waits)

### OBS Integration
- OBS WebSocket v5 control: scene switching, source toggling, stream/record start-stop, mute/unmute
- Script actions can drive OBS alongside on-screen graphics

### AI Assist (bring your own API keys)
- **Script generation** via Anthropic Claude — turns step templates and episode notes into teleprompter text, optionally with actions
- **Requirements generator** — infers the per-episode inputs a producer needs (guest names, images, links, etc.)
- **Document import** — paste a production doc and auto-generate matching graphics, layouts, and formats
- **Media generation** — images via Replicate Flux / OpenAI DALL·E, audio via ElevenLabs / OpenAI TTS
- **Episode data** — export requirements as Excel, re-import filled workbook + `media/` folder as a zip

### Control & Sync
- Real-time Socket.IO sync across all control panels, outputs, and teleprompters
- HTTP API compatible with the h2r.graphics action format
- Lock mode to prevent accidental changes during live shows
- Persistent JSON storage per project

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:4001** in your browser.

By default the server binds to `127.0.0.1`. To expose it on your LAN (e.g. for a browser source on another machine), start with:

```bash
HOST=0.0.0.0 npm start
```

## Usage

1. **Create a project** from the Launcher
2. **Add graphics** from the sidebar
3. **Edit content** directly on each card
4. **Open Output** → add as an OBS Browser Source at 1920×1080 with a transparent background
5. **Toggle ON/OFF** to show/hide graphics on the output
6. **Cue + Run** to stage changes in Preview before going live
7. **Settings** → paste your Anthropic / OBS / Replicate / OpenAI / ElevenLabs keys to unlock AI and OBS features

## OBS Setup

Add a Browser Source pointing to:
```
http://localhost:4001/output/YOUR_PROJECT_ID
```
Set resolution to 1920×1080 with a transparent background.

To drive OBS from OpenProducer, enable the WebSocket server in OBS (Tools → WebSocket Server Settings) and enter the URL/password in OpenProducer Settings.

## API

Base URL: `http://localhost:4001/api/<project-id>/`

| Action | Method | Endpoint |
|--------|--------|----------|
| Show graphic | POST | `/graphic/<id>/show` |
| Hide graphic | POST | `/graphic/<id>/hide` |
| Update graphic | POST | `/graphic/<id>/update` |
| Run cued | POST | `/run` |
| Clear all | POST | `/clear` |
| Update score | POST | `/graphic/<id>/updateScore/<team>/<level>/<type>/<amount>` |
| Timer control | POST | `/graphic/<id>/timer/run\|pause\|reset` |
| Update variable | POST | `/updateVariableText/<id>` |

## Pages

| Page | URL |
|------|-----|
| Launcher | `/` |
| Control Panel | `/rundown/<project-id>` |
| Output (live) | `/output/<project-id>` |
| Preview (cued) | `/preview/<project-id>` |
| Multiview | `/multiview/<project-id>` |
| Teleprompter | `/teleprompter/<project-id>/<script-id>` |
| Teleprompter Flow | `/teleprompter-flow/<project-id>/<script-id>` |

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `4001` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to listen on all interfaces) |

API keys are stored per-project in `data/<project-id>.json` (gitignored). There is no built-in authentication — only expose the server beyond `localhost` on trusted networks.

## License

MIT
