# Implementation Plan: Video Compositing & RTMP Streaming

## Overview

Replace OBS dependency with native video scene compositing (cameras, window capture, PiP layers) and direct RTMP streaming to services like Twitch, YouTube, Twitter/X, Facebook Live, and custom endpoints.

---

## Phase 1: Browser-Based Scene Compositing

### Goal
Capture video inputs (cameras, screens, windows) in the browser and composite them into scenes with picture-in-picture layouts on a canvas — with our graphic overlays rendered on top.

### Architecture
```
[Camera] ──→ getUserMedia() ──→ <video> ──→ ┐
[Screen] ──→ getDisplayMedia() ──→ <video> ──→ ├──→ <canvas 1920x1080> ──→ output
[Window] ──→ getDisplayMedia() ──→ <video> ──→ ┘         ↑
                                              Graphics overlay layer
```

### Implementation Steps

**1.1 Input Source Manager**
- UI in Settings or a new "Sources" tab to add/manage video inputs
- Each source has: id, name, type (`camera`, `screen`, `window`), deviceId
- Camera: use `navigator.mediaDevices.getUserMedia({ video: { deviceId } })`
- Screen/window: use `navigator.mediaDevices.getDisplayMedia()` — note: requires user gesture each time, cannot auto-select a specific window on all browsers
- Store sources as `<video>` elements in memory, continuously streaming

**1.2 Scene Layout Engine**
- A scene defines: which sources are visible, their position/size on the 1920x1080 canvas
- Data model per scene:
  ```json
  {
    "id": "scene_1",
    "name": "The Brew",
    "layers": [
      { "sourceId": "camera_1", "x": 0, "y": 0, "width": 1920, "height": 1080 },
      { "sourceId": "screen_1", "x": 1400, "y": 700, "width": 480, "height": 270 }
    ]
  }
  ```
- Layers are drawn bottom-to-top (first = background, last = foreground)
- Use drag-and-resize in a scene editor to position layers visually

**1.3 Canvas Renderer**
- Create an offscreen `<canvas>` at 1920x1080
- `requestAnimationFrame` loop at 30fps:
  1. Clear canvas
  2. Draw each scene layer's `<video>` source at its position/size
  3. Draw the graphics overlay (from the existing output renderer) on top
- The canvas IS the output — replaces the current HTML-based output page
- Use `canvas.captureStream(30)` to get a `MediaStream` for streaming

**1.4 Scene Switching**
- Extend existing layout/scene switching to also change the canvas composition
- Transitions between scenes: cut (instant), dissolve (crossfade over N frames), or custom
- For dissolve: render both old and new scene simultaneously, blending alpha over time

### Limitations & Mitigations
- `getDisplayMedia()` requires user click — cannot auto-start on page load. Mitigation: prompt user to select sources on first load, keep streams alive
- Cannot programmatically select a specific window — the browser shows a picker. Mitigation: name sources clearly so user picks the right one
- macOS Safari has limited `getDisplayMedia` support. Mitigation: recommend Chrome
- High CPU usage with many video sources. Mitigation: limit to 3-4 simultaneous sources, use hardware acceleration via `willReadFrequently: false` on canvas

### Alternative: Electron App
- Wrapping the app in Electron gives access to `desktopCapturer` API which CAN select specific windows programmatically
- Also gives access to native camera APIs with more control
- Worth considering for Phase 3 if browser limitations are too restrictive

---

## Phase 2: RTMP Streaming

### Goal
Stream the composited output (canvas) to RTMP endpoints (Twitch, YouTube, Twitter, etc.) directly from the app, without OBS.

### Architecture
```
Browser <canvas> ──captureStream()──→ MediaRecorder/WebRTC
                                          │
                                          ▼
                              Node.js Server
                                          │
                                    FFmpeg process
                                    ┌─────┼─────┐
                                    ▼     ▼     ▼
                                Twitch YouTube Twitter
```

### Implementation Steps

**2.1 Canvas to Server Pipeline**
- Option A — MediaRecorder + WebSocket:
  - `canvas.captureStream(30)` → `MediaRecorder` with `video/webm; codecs=vp8`
  - Stream chunks via WebSocket to the Node.js server
  - Server pipes chunks to FFmpeg stdin
  - Latency: ~2-5 seconds

- Option B — WebRTC:
  - `canvas.captureStream(30)` → WebRTC peer connection to server
  - Server uses `wrtc` npm package to receive the stream
  - Lower latency (~500ms) but more complex setup
  - Better for real-time monitoring

- **Recommended: Option A** for simplicity. Option B if sub-second latency matters.

**2.2 FFmpeg Streaming Process**
- Server spawns FFmpeg as a child process:
  ```
  ffmpeg -i pipe:0 -c:v libx264 -preset veryfast -tune zerolatency
         -b:v 6000k -maxrate 6000k -bufsize 12000k
         -pix_fmt yuv420p -g 60 -keyint_min 60
         -c:a aac -b:a 128k -ar 44100
         -f flv rtmp://DESTINATION/STREAM_KEY
  ```
- Input: WebM chunks piped to stdin
- Output: H.264 + AAC over RTMP to the destination
- FFmpeg handles the WebM → H.264 transcoding and RTMP muxing

**2.3 Audio Handling**
- Capture audio alongside video:
  - `getUserMedia({ audio: true })` for microphone
  - `getDisplayMedia({ audio: true })` for system audio
  - Mix using Web Audio API (`AudioContext`, `createMediaStreamDestination`)
- Include mixed audio in the `captureStream()` or add as separate MediaRecorder track
- FFmpeg receives both video and audio

**2.4 Streaming Settings UI**
- New "Streaming" section in Settings:
  ```
  Service:     [Twitch / YouTube / Twitter / Facebook / Custom RTMP]
  Server:      [auto-populated based on service, or custom URL]
  Stream Key:  [password field]
  Bitrate:     [2500 / 4500 / 6000 / 8000 kbps]
  Resolution:  [1920x1080 / 1280x720]
  FPS:         [30 / 60]
  ```
- Preset RTMP URLs per service:
  - Twitch: `rtmp://live.twitch.tv/app/`
  - YouTube: `rtmp://a.rtmp.youtube.com/live2/`
  - Twitter/X: uses RTMPS — `rtmps://prod-ec-us-east-1.video.pscp.tv:443/x/`
  - Facebook: `rtmps://live-api-s.facebook.com:443/rtmp/`
  - Custom: user enters full URL

**2.5 Multi-Destination Streaming**
- Allow multiple simultaneous destinations
- Each destination is a separate FFmpeg process reading from the same input
- Or use a local RTMP relay (`node-media-server`) that re-streams to multiple endpoints
- UI shows status per destination: connecting, live, bitrate, dropped frames

**2.6 Stream Controls**
- Start/Stop Stream button in the control panel header
- Stream status indicator (red dot + duration when live)
- Integration with scripts: add "Start Stream" / "Stop Stream" as actions
- Health monitoring: FFmpeg stderr parsed for bitrate, dropped frames, connection status

### Dependencies
- `ffmpeg` must be installed on the system (or bundled)
- `node-media-server` (optional, for relay approach)
- `wrtc` npm package (only if using WebRTC approach)

---

## Phase 3: Full OBS Replacement

### Goal
Complete self-contained broadcast studio — no external software needed.

### Additional Features Needed

**3.1 Recording**
- Same FFmpeg pipeline but output to file instead of RTMP
- Format: MP4 (H.264 + AAC) or MKV for crash-resilience
- UI: Record button, file path setting, recording indicator

**3.2 Virtual Camera**
- Output the composited canvas as a virtual camera device
- macOS: use `OBS-VirtualCam` protocol or `CamTwist` API
- Or: Electron + native module to create a virtual camera
- Allows using the output in Zoom, Google Meet, etc.

**3.3 Audio Mixer**
- Per-source volume controls
- Mute/unmute per source
- Audio monitoring (VU meters)
- Ducking: auto-lower music when mic is active
- Web Audio API handles all of this

**3.4 Transition Engine**
- Cut, dissolve, wipe, stinger transitions between scenes
- Stinger: a video file (with alpha) that plays during the transition
- Implemented by rendering transition frames on the canvas during scene switches

**3.5 Electron Wrapper**
- Package the app as a desktop application
- Gains: programmatic window capture, virtual camera, system tray, auto-start
- Use `electron-builder` for macOS/Windows/Linux distribution
- The Node.js server runs as the main process, browser UI as the renderer

---

## Recommended Roadmap

| Phase | Effort | What You Get |
|-------|--------|-------------|
| **Current** | Done | Graphics, scripts, OBS control via WebSocket |
| **1.1-1.2** | 1-2 weeks | Source management + scene layout data model |
| **1.3** | 1 week | Canvas-based video compositing (replaces OBS for compositing) |
| **2.1-2.2** | 1 week | Basic RTMP streaming via FFmpeg |
| **2.4-2.5** | 3-4 days | Streaming UI with service presets + multi-destination |
| **1.4** | 3-4 days | Scene transitions (cut, dissolve) |
| **3.1** | 2-3 days | Local recording |
| **3.3** | 1 week | Audio mixer |
| **3.5** | 1 week | Electron packaging |
| **3.2** | 3-4 days | Virtual camera (Electron required) |
| **3.4** | 1 week | Advanced transitions (stingers) |

**Total to full OBS replacement: ~8-10 weeks of focused development.**

### Short-term recommendation
Keep OBS for now. Your app's competitive advantage is the scripting/AI/teleprompter layer, not video compositing. Phase 1-2 makes sense when you want to distribute the app to users who don't want to install and configure OBS separately.
