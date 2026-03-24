const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const OBSWebSocket = require('obs-websocket-js').default;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PORT = process.env.PORT || 4001;

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ─── Helper: generate short project ID ──────────────────────────────────────
function shortId() {
  return uuidv4().slice(0, 8).toUpperCase();
}

// ─── Helper: load / save projects ───────────────────────────────────────────
function projectPath(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

function loadProject(id) {
  const p = projectPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function saveProject(project) {
  fs.writeFileSync(projectPath(project.id), JSON.stringify(project, null, 2));
}

function listProjects() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
      return { id: data.id, name: data.name, createdAt: data.createdAt };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function createDefaultProject(name) {
  return {
    id: shortId(),
    name: name || 'My Project',
    createdAt: new Date().toISOString(),
    graphics: [],
    variables: {
      text: [
        { id: 'text.1', value: '' },
        { id: 'text.2', value: '' },
        { id: 'text.3', value: '' }
      ],
      lists: [
        {
          id: 'list1',
          columns: ['Name', 'Company', 'Title'],
          rows: [],
          selectedRow: -1
        }
      ]
    },
    theme: {
      primaryColor: '#e63946',
      secondaryColor: '#1d3557',
      textColor: '#ffffff',
      fontFamily: 'Arial, sans-serif',
      customCSS: ''
    },
    scripts: [],
    formats: [],
    settings: {
      anthropicApiKey: '',
      aiModel: 'claude-opus-4-6',
      obsUrl: 'ws://localhost:4455',
      obsPassword: '',
      workingDirectory: '',
      replicateApiKey: '',
      elevenLabsApiKey: '',
      openaiApiKey: ''
    }
  };
}

// ─── REST API: Projects ─────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  res.json(listProjects());
});

app.post('/api/projects', (req, res) => {
  const project = createDefaultProject(req.body.name);
  saveProject(project);
  res.json(project);
});

app.post('/api/projects/:id/duplicate', (req, res) => {
  const src = loadProject(req.params.id);
  if (!src) return res.status(404).json({ error: 'Project not found' });
  const dup = { ...JSON.parse(JSON.stringify(src)), id: shortId(), name: src.name + ' (Copy)', createdAt: new Date().toISOString() };
  saveProject(dup);
  res.json(dup);
});

app.delete('/api/projects/:id', (req, res) => {
  const p = projectPath(req.params.id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// ─── REST API: Full project state ───────────────────────────────────────────
app.get('/api/:projectId', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

app.put('/api/:projectId', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  Object.assign(project, req.body, { id: project.id });
  saveProject(project);
  io.to(project.id).emit('project:update', project);
  res.json(project);
});

// ─── REST API: Graphics CRUD ────────────────────────────────────────────────
app.post('/api/:projectId/graphics', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const graphic = {
    id: shortId(),
    type: req.body.type,
    name: req.body.name || req.body.type,
    content: req.body.content || getDefaultContent(req.body.type),
    isLive: false,
    isCued: false,
    order: project.graphics.length
  };
  project.graphics.push(graphic);
  saveProject(project);
  io.to(project.id).emit('project:update', project);
  res.json(graphic);
});

app.put('/api/:projectId/graphics/:graphicId', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const idx = project.graphics.findIndex(g => g.id === req.params.graphicId);
  if (idx === -1) return res.status(404).json({ error: 'Graphic not found' });
  Object.assign(project.graphics[idx], req.body, { id: project.graphics[idx].id });
  saveProject(project);
  io.to(project.id).emit('project:update', project);
  res.json(project.graphics[idx]);
});

app.delete('/api/:projectId/graphics/:graphicId', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  project.graphics = project.graphics.filter(g => g.id !== req.params.graphicId);
  saveProject(project);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// ─── REST API: h2r-compatible endpoints ─────────────────────────────────────
// POST /api/:projectId/graphic/:graphicId/show
app.post('/api/:projectId/graphic/:graphicId/show', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const g = project.graphics.find(g => g.id === req.params.graphicId);
  if (!g) return res.status(404).json({ error: 'Graphic not found' });
  g.isLive = true;
  g.isCued = false;
  saveProject(project);
  io.to(project.id).emit('graphic:show', g);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// POST /api/:projectId/graphic/:graphicId/hide
app.post('/api/:projectId/graphic/:graphicId/hide', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const g = project.graphics.find(g => g.id === req.params.graphicId);
  if (!g) return res.status(404).json({ error: 'Graphic not found' });
  g.isLive = false;
  g.isCued = false;
  saveProject(project);
  io.to(project.id).emit('graphic:hide', g);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// POST /api/:projectId/graphic/:graphicId/update
app.post('/api/:projectId/graphic/:graphicId/update', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const g = project.graphics.find(g => g.id === req.params.graphicId);
  if (!g) return res.status(404).json({ error: 'Graphic not found' });
  Object.assign(g.content, req.body);
  saveProject(project);
  io.to(project.id).emit('graphic:update', g);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// POST /api/:projectId/run
app.post('/api/:projectId/run', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  project.graphics.forEach(g => {
    if (g.isCued && !g.isLive) {
      g.isLive = true;
      g.isCued = false;
      io.to(project.id).emit('graphic:show', g);
    } else if (g.isLive && g.isCued) {
      g.isLive = false;
      g.isCued = false;
      io.to(project.id).emit('graphic:hide', g);
    }
  });
  saveProject(project);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// POST /api/:projectId/clear
app.post('/api/:projectId/clear', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  project.graphics.forEach(g => {
    if (g.isLive) {
      g.isLive = false;
      io.to(project.id).emit('graphic:hide', g);
    }
    g.isCued = false;
  });
  saveProject(project);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// Score API
app.post('/api/:projectId/graphic/:graphicId/updateScore/:team/:level/:type/:amount', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const g = project.graphics.find(g => g.id === req.params.graphicId);
  if (!g || g.type !== 'score') return res.status(404).json({ error: 'Score graphic not found' });
  const { team, level, type, amount } = req.params;
  const key = `team${team}`;
  if (!g.content[key]) return res.status(400).json({ error: 'Invalid team' });
  const amt = parseInt(amount, 10);
  if (type === 'set') g.content[key].score = amt;
  else if (type === 'up') g.content[key].score += amt;
  else if (type === 'down') g.content[key].score -= amt;
  saveProject(project);
  io.to(project.id).emit('graphic:update', g);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// Timer API
app.post('/api/:projectId/graphic/:graphicId/timer/:action', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const g = project.graphics.find(g => g.id === req.params.graphicId);
  if (!g || g.type !== 'timer') return res.status(404).json({ error: 'Timer graphic not found' });
  io.to(project.id).emit('timer:action', { id: g.id, action: req.params.action });
  res.json({ ok: true });
});

app.post('/api/:projectId/graphic/:graphicId/timer/jump/:seconds', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const g = project.graphics.find(g => g.id === req.params.graphicId);
  if (!g || g.type !== 'timer') return res.status(404).json({ error: 'Timer graphic not found' });
  io.to(project.id).emit('timer:action', { id: g.id, action: 'jump', seconds: parseInt(req.params.seconds) });
  res.json({ ok: true });
});

app.post('/api/:projectId/graphic/:graphicId/timer/duration/:seconds', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const g = project.graphics.find(g => g.id === req.params.graphicId);
  if (!g || g.type !== 'timer') return res.status(404).json({ error: 'Timer graphic not found' });
  g.content.duration = parseInt(req.params.seconds);
  saveProject(project);
  io.to(project.id).emit('timer:action', { id: g.id, action: 'duration', seconds: parseInt(req.params.seconds) });
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// Variable text API
app.post('/api/:projectId/updateVariableText/:varId', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const v = project.variables.text.find(t => t.id === req.params.varId);
  if (!v) return res.status(404).json({ error: 'Variable not found' });
  v.value = req.body.text || '';
  saveProject(project);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// Variable list API
app.post('/api/:projectId/updateVariableList/:listId/selectRow/:selector', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const list = project.variables.lists.find(l => l.id === req.params.listId);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const { selector } = req.params;
  if (selector === 'next') list.selectedRow = Math.min(list.selectedRow + 1, list.rows.length - 1);
  else if (selector === 'previous') list.selectedRow = Math.max(list.selectedRow - 1, 0);
  else list.selectedRow = parseInt(selector, 10);
  saveProject(project);
  io.to(project.id).emit('project:update', project);
  res.json({ ok: true });
});

// ─── AI Script Generation ───────────────────────────────────────────────────
app.post('/api/:projectId/generate-script', async (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const settings = project.settings || {};
  const apiKey = settings.anthropicApiKey;
  if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not set. Go to Settings.' });

  const { steps, globalNotes, globalMedia, formatName, aiActionsEnabled, aiAvailableActions, aiMediaEnabled, aiMediaServices } = req.body;
  const canAddActions = aiActionsEnabled && aiAvailableActions && aiAvailableActions.length > 0;
  const canGenerateMedia = aiMediaEnabled && aiMediaServices && aiMediaServices.length > 0;

  // Build prompt
  let systemPrompt = `You are a broadcast script writer. You generate teleprompter scripts for live productions.
Write natural, conversational teleprompter text that a host can read aloud.
For locked steps, return the exact existing text unchanged.
Keep the tone professional but engaging.`;

  if (canAddActions) {
    systemPrompt += `\n\nYou may also add actions to unlocked steps when appropriate.
Return a JSON array of objects: [{"text": "...", "actions": [...]}, ...]
Each action object must use EXACTLY one of these available actions (by id):
${aiAvailableActions.map(a => `  - id: "${a.id}" → ${a.label} (type: ${a.type}${a.graphicId ? ', graphicId: "'+a.graphicId+'"' : ''}${a.path ? ', path: "'+a.path+'"' : ''}${a.obsAction ? ', obsAction: "'+a.obsAction+'"' : ''})`).join('\n')}

Action format: {"type": "<type>", "graphicId": "<id>", "path": "<path>", "value": "<value>", "obsAction": "<obsAction>", "obsValue": "<value>", "duration": <seconds>}
Only include fields relevant to the action type. Only add actions when they genuinely enhance the broadcast.
For steps where no actions are needed, use an empty array.
For locked steps, return {"text": "<exact locked text>", "actions": []}.`;
  } else if (canGenerateMedia) {
    systemPrompt += `\nReturn a JSON array of objects: [{"text": "...", "media": [...]}, ...]`;
  } else {
    systemPrompt += `\nReturn ONLY a JSON array of strings, one per step. Example: ["Text for step 1", "Text for step 2"]`;
  }

  if (canGenerateMedia) {
    const serviceDescs = aiMediaServices.map(s => {
      if (s.id === 'replicate_image') return `- replicate_image: Generate images via Replicate Flux (fast, high quality). Use for backgrounds, overlays, illustrations.`;
      if (s.id === 'openai_image') return `- openai_image: Generate images via DALL-E 3 (detailed, creative). Use for specific scenes, artistic visuals.`;
      if (s.id === 'elevenlabs_audio') return `- elevenlabs_audio: Generate voice/audio via ElevenLabs. Use for intros, transitions, voiceovers.`;
      if (s.id === 'openai_audio') return `- openai_audio: Generate speech via OpenAI TTS. Use for narration, announcements.`;
      return '';
    }).filter(Boolean).join('\n');

    systemPrompt += `\n\nYou can request media generation for unlocked steps when it would enhance the broadcast.
Available media services:
${serviceDescs}

Add a "media" array to any step object:
- For images: {"type": "image", "service": "replicate_image"|"openai_image", "prompt": "detailed visual description for the image"}
- For audio: {"type": "audio", "service": "elevenlabs_audio"|"openai_audio", "text": "text to speak or describe"}

Each media item should also include "target" (a description like "background image" or "transition sound") so we know what it's for.
Only generate media when it genuinely adds value. Don't generate media for every step.
For locked steps, never add media.`;
  }

  let userPrompt = `Generate teleprompter script text for a broadcast segment called "${formatName || 'Untitled'}".

`;
  if (globalNotes) userPrompt += `Overall context/notes: ${globalNotes}\n\n`;
  if (globalMedia && globalMedia.length) userPrompt += `Reference media files: ${globalMedia.join(', ')}\n\n`;

  userPrompt += `Steps:\n`;
  steps.forEach((s, i) => {
    userPrompt += `\n--- Step ${i + 1}: ${s.label || 'Untitled'} ---\n`;
    if (s.locked) {
      userPrompt += `[LOCKED - return this exact text]: "${s.text}"\n`;
    } else {
      if (s.defaultText) userPrompt += `Template text: "${s.defaultText}"\n`;
      if (s.notes) userPrompt += `Notes: ${s.notes}\n`;
      if (s.media && s.media.length) userPrompt += `Media references: ${s.media.join(', ')}\n`;
      if (s.actions && s.actions.length) {
        const actionDesc = s.actions.map(a => {
          if (a.type === 'show') return `Show graphic`;
          if (a.type === 'hide') return `Hide graphic`;
          if (a.type === 'wait') return `Wait ${a.duration}s`;
          if (a.type === 'obs') return `OBS: ${a.obsAction}`;
          if (a.type === 'update') return `Update graphic`;
          return '';
        }).filter(Boolean).join(', ');
        userPrompt += `Existing actions: ${actionDesc}\n`;
      }
    }
  });

  if (canAddActions) {
    userPrompt += `\nReturn a JSON array of ${steps.length} objects: [{"text": "...", "actions": [...]}, ...]`;
  } else {
    userPrompt += `\nReturn a JSON array of ${steps.length} strings.`;
  }

  try {
    const model = settings.aiModel || 'claude-opus-4-6';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.content?.[0]?.text || '';
    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'Could not parse AI response', raw: text });
    const generated = JSON.parse(match[0]);

    // Process any media generation requests
    if (canGenerateMedia) {
      for (let i = 0; i < generated.length; i++) {
        const step = generated[i];
        if (step && typeof step === 'object' && step.media && Array.isArray(step.media)) {
          for (let j = 0; j < step.media.length; j++) {
            const m = step.media[j];
            try {
              const svc = m.service.replace('_image', '').replace('_audio', '');
              if (m.type === 'image') {
                m.url = await generateImage(svc === 'replicate' ? 'replicate' : 'openai', m.prompt, settings);
              } else if (m.type === 'audio') {
                m.url = await generateAudio(svc === 'elevenlabs' ? 'elevenlabs' : 'openai', m.text, settings);
              }
              m.generated = true;
            } catch (e) {
              m.error = e.message;
            }
          }
        }
      }
    }

    res.json({ steps: generated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Media Generation ────────────────────────────────────────────────────────
async function generateImage(service, prompt, settings) {
  if (service === 'replicate' && settings.replicateApiKey) {
    // Use Replicate Flux model
    const createRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.replicateApiKey}` },
      body: JSON.stringify({
        model: 'black-forest-labs/flux-schnell',
        input: { prompt, aspect_ratio: '16:9' }
      })
    });
    const prediction = await createRes.json();
    if (prediction.error) throw new Error(prediction.error);
    // Poll for completion
    let result = prediction;
    for (let i = 0; i < 60; i++) {
      if (result.status === 'succeeded') break;
      if (result.status === 'failed') throw new Error('Image generation failed');
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${result.id}`, {
        headers: { 'Authorization': `Bearer ${settings.replicateApiKey}` }
      });
      result = await pollRes.json();
    }
    const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    // Download and save locally
    return await downloadToUploads(imageUrl);
  }
  if (service === 'openai' && settings.openaiApiKey) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.openaiApiKey}` },
      body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1792x1024', response_format: 'url' })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return await downloadToUploads(data.data[0].url);
  }
  throw new Error(`No API key for ${service}`);
}

async function generateAudio(service, text, settings) {
  if (service === 'elevenlabs' && settings.elevenLabsApiKey) {
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': settings.elevenLabsApiKey },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' })
    });
    if (!res.ok) throw new Error('ElevenLabs error: ' + res.statusText);
    const buffer = Buffer.from(await res.arrayBuffer());
    const filename = uuidv4().slice(0, 12) + '.mp3';
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    return `/uploads/${filename}`;
  }
  if (service === 'openai' && settings.openaiApiKey) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.openaiApiKey}` },
      body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: text })
    });
    if (!res.ok) throw new Error('OpenAI TTS error: ' + res.statusText);
    const buffer = Buffer.from(await res.arrayBuffer());
    const filename = uuidv4().slice(0, 12) + '.mp3';
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    return `/uploads/${filename}`;
  }
  throw new Error(`No API key for ${service}`);
}

async function downloadToUploads(url) {
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[contentType] || '.png';
  const filename = uuidv4().slice(0, 12) + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

// Process media generation requests from AI
app.post('/api/:projectId/generate-media', async (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const settings = project.settings || {};
  const { requests } = req.body; // [{type:'image'|'audio', service, prompt, text}]
  const results = [];
  for (const r of requests) {
    try {
      if (r.type === 'image') {
        const url = await generateImage(r.service, r.prompt, settings);
        results.push({ ...r, url, ok: true });
      } else if (r.type === 'audio') {
        const url = await generateAudio(r.service, r.text, settings);
        results.push({ ...r, url, ok: true });
      }
    } catch (e) {
      results.push({ ...r, error: e.message, ok: false });
    }
  }
  res.json({ results });
});

// ─── Folder picker (macOS/Linux) ─────────────────────────────────────────────
app.post('/api/pick-folder', async (req, res) => {
  const { execSync } = require('child_process');
  try {
    let folder;
    if (process.platform === 'darwin') {
      folder = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select working directory")'`,
        { encoding: 'utf-8', timeout: 60000 }
      ).trim();
    } else {
      // Linux with zenity
      folder = execSync(
        `zenity --file-selection --directory --title="Select working directory"`,
        { encoding: 'utf-8', timeout: 60000 }
      ).trim();
    }
    if (folder) return res.json({ path: folder });
    res.json({ path: '' });
  } catch (e) {
    res.json({ path: '', cancelled: true });
  }
});

// ─── File upload ────────────────────────────────────────────────────────────
app.post('/api/upload',
  express.raw({ type: 'image/*', limit: '20mb' }),
  (req, res) => {
    const contentType = req.headers['content-type'] || '';
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' }[contentType] || '.png';
    const filename = uuidv4().slice(0, 12) + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.body);
    res.json({ url: `/uploads/${filename}` });
  }
);

// ─── Page routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'launcher.html'));
});

app.get('/rundown/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

app.get('/output/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'output.html'));
});

app.get('/preview/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'output.html'));
});

app.get('/multiview/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'multiview.html'));
});

app.get('/teleprompter/:projectId/:scriptId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teleprompter.html'));
});

app.get('/teleprompter-flow/:projectId/:scriptId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teleprompter-flow.html'));
});

// ─── OBS WebSocket ──────────────────────────────────────────────────────────
const obs = new OBSWebSocket();
let obsConnected = false;

async function obsConnect(url, password) {
  try {
    await obs.disconnect().catch(() => {});
    await obs.connect(url || 'ws://localhost:4455', password || undefined);
    obsConnected = true;
    console.log('  OBS WebSocket connected');
    io.emit('obs:status', { connected: true });
  } catch (e) {
    obsConnected = false;
    console.log('  OBS WebSocket failed:', e.message);
    io.emit('obs:status', { connected: false, error: e.message });
  }
}

obs.on('ConnectionClosed', () => {
  obsConnected = false;
  io.emit('obs:status', { connected: false });
});

async function executeOBSAction(action) {
  if (!obsConnected) return { error: 'OBS not connected' };
  try {
    switch (action.obsAction) {
      case 'switch_scene':
        await obs.call('SetCurrentProgramScene', { sceneName: action.obsValue });
        break;
      case 'toggle_source':
        await obs.call('SetSceneItemEnabled', {
          sceneName: action.obsScene || undefined,
          sceneItemId: parseInt(action.obsValue),
          sceneItemEnabled: action.obsEnabled !== false
        });
        break;
      case 'start_stream': await obs.call('StartStream'); break;
      case 'stop_stream': await obs.call('StopStream'); break;
      case 'toggle_stream': await obs.call('ToggleStream'); break;
      case 'start_record': await obs.call('StartRecord'); break;
      case 'stop_record': await obs.call('StopRecord'); break;
      case 'toggle_record': await obs.call('ToggleRecord'); break;
      case 'mute': await obs.call('SetInputMute', { inputName: action.obsValue, inputMuted: true }); break;
      case 'unmute': await obs.call('SetInputMute', { inputName: action.obsValue, inputMuted: false }); break;
      case 'toggle_mute': await obs.call('ToggleInputMute', { inputName: action.obsValue }); break;
    }
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

// OBS REST endpoints
app.post('/api/obs/connect', async (req, res) => {
  await obsConnect(req.body.url, req.body.password);
  res.json({ connected: obsConnected });
});

app.get('/api/obs/status', (req, res) => {
  res.json({ connected: obsConnected });
});

app.get('/api/obs/scenes', async (req, res) => {
  if (!obsConnected) return res.json({ scenes: [] });
  try {
    const { scenes } = await obs.call('GetSceneList');
    res.json({ scenes: scenes.map(s => s.sceneName) });
  } catch (e) { res.json({ scenes: [], error: e.message }); }
});

app.get('/api/obs/inputs', async (req, res) => {
  if (!obsConnected) return res.json({ inputs: [] });
  try {
    const { inputs } = await obs.call('GetInputList');
    res.json({ inputs: inputs.map(i => i.inputName) });
  } catch (e) { res.json({ inputs: [], error: e.message }); }
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('obs:status', { connected: obsConnected });
  socket.on('join', (projectId) => {
    socket.join(projectId);
    const project = loadProject(projectId);
    if (project) socket.emit('project:update', project);
  });

  socket.on('graphic:toggle', ({ projectId, graphicId }) => {
    const project = loadProject(projectId);
    if (!project) return;
    const g = project.graphics.find(g => g.id === graphicId);
    if (!g) return;
    if (g.isLive) {
      g.isLive = false;
      io.to(projectId).emit('graphic:hide', g);
    } else {
      g.isLive = true;
      io.to(projectId).emit('graphic:show', g);
    }
    g.isCued = false;
    saveProject(project);
    io.to(projectId).emit('project:update', project);
  });

  socket.on('graphic:cue', ({ projectId, graphicId }) => {
    const project = loadProject(projectId);
    if (!project) return;
    const g = project.graphics.find(g => g.id === graphicId);
    if (!g) return;
    g.isCued = !g.isCued;
    saveProject(project);
    io.to(projectId).emit('project:update', project);
  });

  socket.on('project:save', (project) => {
    saveProject(project);
    io.to(project.id).emit('project:update', project);
  });

  socket.on('obs:connect', async ({ url, password }) => {
    await obsConnect(url, password);
  });

  socket.on('script:execute', async ({ projectId, actions }) => {
    const project = loadProject(projectId);
    if (!project) return;

    async function runAction(action) {
      // Wait
      if (action.type === 'wait') {
        const ms = Math.max(0, (action.duration || 1)) * 1000;
        await new Promise(resolve => setTimeout(resolve, ms));
        return;
      }
      // OBS
      if (action.type === 'obs') {
        await executeOBSAction(action);
        return;
      }
      // Graphic actions
      const g = project.graphics.find(g => g.id === action.graphicId);
      if (!g) return;
      switch (action.type) {
        case 'show':
          g.isLive = true; g.isCued = false;
          io.to(projectId).emit('graphic:show', g);
          break;
        case 'hide':
          g.isLive = false; g.isCued = false;
          io.to(projectId).emit('graphic:hide', g);
          break;
        case 'update':
          if (action.path) {
            const parts = action.path.split('.');
            let target = g.content;
            for (let i = 0; i < parts.length - 1; i++) target = target[parts[i]];
            target[parts[parts.length - 1]] = action.value;
          }
          io.to(projectId).emit('graphic:update', g);
          break;
      }
    }

    // Execute sequentially so waits pause between actions
    for (const action of actions) {
      await runAction(action);
    }
    saveProject(project);
    io.to(projectId).emit('project:update', project);
  });
});

// ─── Default content per graphic type ───────────────────────────────────────
function getDefaultContent(type) {
  switch (type) {
    case 'lower_third':
      return { title: 'Name', subtitle: 'Title / Company' };
    case 'message':
      return { text: 'Breaking News', detail: 'Details here...' };
    case 'ticker':
      return { items: ['Item 1', 'Item 2', 'Item 3'], speed: 60 };
    case 'image':
      return { url: '', sizing: 'contain', library: [] };
    case 'timer':
      return { mode: 'countdown', duration: 300, format: 'mm:ss', label: 'Timer' };
    case 'score':
      return {
        team1: { name: 'Team A', score: 0, color: '#e63946' },
        team2: { name: 'Team B', score: 0, color: '#1d3557' }
      };
    default:
      return {};
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const ifaces = require('os').networkInterfaces();
  let localIP = '127.0.0.1';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }
  console.log(`\n  ┌──────────────────────────────────────────┐`);
  console.log(`  │       My Broadcast Graphics              │`);
  console.log(`  ├──────────────────────────────────────────┤`);
  console.log(`  │  Local:   http://localhost:${PORT}/        │`);
  console.log(`  │  Network: http://${localIP}:${PORT}/  │`);
  console.log(`  └──────────────────────────────────────────┘\n`);
});
