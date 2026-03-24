# My Broadcast

A local broadcast graphics overlay application for live productions, inspired by [h2r.graphics](https://h2r.graphics/). Built with Node.js, Express, and Socket.IO.

## Features

- **Graphic Types** — Lower Thirds, Messages, Tickers, Images, Timers, Scoreboards
- **Real-time Control** — Socket.IO keeps all control panels and outputs in sync
- **Transparent Output** — 1920x1080 overlay for OBS/vMix browser sources
- **Multiview** — Side-by-side Preview (cued) and Program (live) monitors
- **Card-based Rundown** — Responsive grid with inline editing, drag-and-drop reorder, and per-card color coding
- **Cue System** — Stage graphics in Preview, then fire them all with Run
- **Variables** — `[text.1]`, `[list1.1]` syntax for dynamic data
- **Theme Editor** — Primary/secondary colors, fonts, custom CSS
- **HTTP API** — Compatible with h2r.graphics API format
- **Lock Mode** — Prevent accidental changes during live shows
- **Persistent Storage** — Projects saved as JSON files

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:4001** in your browser.

## Usage

1. **Create a project** from the Launcher
2. **Add graphics** from the sidebar
3. **Edit content** directly on each card
4. **Open Output** → add as OBS Browser Source at 1920x1080 (transparent background)
5. **Toggle ON/OFF** to show/hide graphics on the output
6. **Cue + Run** to stage changes in Preview before going live

## OBS Setup

Add a Browser Source pointing to:
```
http://localhost:4001/output/YOUR_PROJECT_ID
```
Set resolution to 1920x1080 with a transparent background.

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
