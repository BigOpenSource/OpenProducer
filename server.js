const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const OBSWebSocket = require('obs-websocket-js').default;
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');

// Load .env (tiny inline loader — no dotenv dep)
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m || m[1].startsWith('#')) continue;
    const [, k, rawV] = m;
    if (process.env[k]) continue;
    const v = rawV.replace(/^['"]|['"]$/g, '');
    process.env[k] = v;
  }
})();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PORT = process.env.PORT || 4001;
const HOST = process.env.HOST || '127.0.0.1';

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ─── Job tracking ───────────────────────────────────────────────────────────
const jobs = new Map(); // projectId -> {id, type, status, message, startedAt}
app.get('/api/:projectId/jobs', (req, res) => {
  const job = jobs.get(req.params.projectId);
  res.json({ job: job || null });
});
function setJob(projectId, type, message) {
  const job = { id: Date.now().toString(), type, status: 'running', message, startedAt: new Date().toISOString() };
  jobs.set(projectId, job);
  io.to(projectId).emit('job:update', job);
  return job;
}
function finishJob(projectId, message, error) {
  const job = jobs.get(projectId);
  if (job) {
    job.status = error ? 'error' : 'done';
    job.message = message;
    job.finishedAt = new Date().toISOString();
    io.to(projectId).emit('job:update', job);
    // Clear after 30s
    setTimeout(() => { if (jobs.get(projectId) === job) jobs.delete(projectId); }, 30000);
  }
}

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
  try { reconcileSocialSessions(project); } catch (e) { console.warn('[social] reconcile error:', e.message); }
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
      style: 'classic',
      primaryColor: '#e63946',
      secondaryColor: '#1d3557',
      textColor: '#ffffff',
      fontFamily: 'Arial, sans-serif',
      customCSS: ''
    },
    scripts: [],
    formats: [],
    layouts: [],
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

  // Include episode requirements
  const { requirements } = req.body;
  if (requirements && requirements.length) {
    userPrompt += `Episode-specific details provided by the producer:\n`;
    requirements.forEach(r => {
      if (r.value) userPrompt += `- ${r.label}: ${r.value}\n`;
      if (r.files && r.files.length) userPrompt += `- ${r.label} (files): ${r.files.join(', ')}\n`;
    });
    userPrompt += '\n';
  }
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

// ─── JSON repair helper ─────────────────────────────────────────────────────
function repairJSON(text) {
  // Extract the JSON portion
  let json = text;
  // Try array first, then object
  const arrMatch = text.match(/\[[\s\S]*/);
  const objMatch = text.match(/\{[\s\S]*/);
  if (arrMatch) json = arrMatch[0];
  else if (objMatch) json = objMatch[0];

  // Try parsing as-is
  try { return JSON.parse(json); } catch(e) {}

  // Find the last valid closing point and truncate there
  let lastValid = -1;
  let depth = 0, inStr = false, escape = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') { depth--; if (depth === 0) lastValid = i; }
  }
  if (lastValid > 0) {
    return JSON.parse(json.slice(0, lastValid + 1));
  }

  // Fallback: close unclosed brackets
  let repaired = json.replace(/,\s*$/, '').replace(/,\s*"[^"]*$/, '').replace(/:\s*"[^"]*$/, ': ""');
  let open = 0, openArr = 0;
  inStr = false; escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') open++; if (ch === '}') open--;
    if (ch === '[') openArr++; if (ch === ']') openArr--;
  }
  while (open > 0) { repaired += '}'; open--; }
  while (openArr > 0) { repaired += ']'; openArr--; }
  return JSON.parse(repaired);
}

// ─── Generate Requirements ──────────────────────────────────────────────────
app.post('/api/:projectId/generate-requirements', async (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const settings = project.settings || {};
  if (!settings.anthropicApiKey) return res.status(400).json({ error: 'Anthropic API key not set.' });

  const { stepsDesc, graphicsDesc, formatName } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: settings.aiModel || 'claude-opus-4-6',
        max_tokens: 2048,
        system: `You analyze broadcast script formats and determine what episode-specific information a producer needs to provide before each episode.
Return a JSON array of requirement objects: [{"type":"text"|"file"|"url"|"choice", "label":"<descriptive label>"}]
For choice type, also include "options": "option1, option2, option3"
Think about what changes per episode: guest names, topics, headlines, images, links, etc.
Look at update actions with placeholder values — those are things the producer needs to fill in.
IMPORTANT: Each story/segment that shows visuals likely needs image or video assets. Use type "file" for:
- Story images/graphics (one per story)
- B-roll video clips
- Audio clips or sound effects
- Guest photos
Also use type "url" for article links or reference URLs.
Be practical and thorough. Include both text info AND media assets needed.`,
        messages: [{ role: 'user', content: `Analyze this broadcast format and list what the producer needs to provide for each episode:\n\nFormat: ${formatName}\n\nSteps:\n${stepsDesc}\n\nAvailable graphics:\n${graphicsDesc}` }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'Could not parse response' });
    res.json({ requirements: JSON.parse(match[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Episode Data Export/Import ──────────────────────────────────────────────
app.post('/api/:projectId/export-requirements', async (req, res) => {
  const { requirements, scriptName } = req.body;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Episode Requirements');

  // Header row
  ws.columns = [
    { header: '#', key: 'num', width: 5 },
    { header: 'Requirement', key: 'label', width: 40 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Value', key: 'value', width: 50 },
    { header: 'File Name', key: 'filename', width: 30 },
    { header: 'Notes', key: 'notes', width: 40 }
  ];

  // Style header
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C5CE7' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  requirements.forEach((r, i) => {
    const row = {
      num: i + 1,
      label: r.label,
      type: r.type,
      value: '',
      filename: '',
      notes: ''
    };
    if (r.type === 'file') {
      // Generate expected filename
      const safeName = r.label.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_').toLowerCase();
      row.filename = safeName;
      row.notes = `Place file in media/ folder named: ${safeName}.png (or .jpg, .mp4, .mp3, etc.)`;
    } else if (r.type === 'choice' && r.options) {
      row.notes = `Options: ${r.options}`;
    }
    ws.addRow(row);
  });

  // Instructions sheet
  const is = wb.addWorksheet('Instructions');
  is.getColumn(1).width = 80;
  is.addRow(['EPISODE DATA INSTRUCTIONS']);
  is.getRow(1).font = { bold: true, size: 14 };
  is.addRow(['']);
  is.addRow(['1. Fill in the "Value" column for each requirement on the first sheet.']);
  is.addRow(['2. For file requirements, place your media files in a folder called "media/"']);
  is.addRow(['3. Name each media file using the "File Name" column value (e.g., story_1_visual_asset.png)']);
  is.addRow(['4. Supported formats: .png, .jpg, .gif, .webp, .mp4, .webm, .mp3, .wav, .aac']);
  is.addRow(['5. Save this Excel file, then zip it together with the media/ folder:']);
  is.addRow(['']);
  is.addRow(['   episode_data.zip']);
  is.addRow(['   ├── requirements.xlsx  (this file, filled out)']);
  is.addRow(['   └── media/']);
  is.addRow(['       ├── story_1_headline_image.png']);
  is.addRow(['       ├── story_2_visual_asset.jpg']);
  is.addRow(['       └── ...']);
  is.addRow(['']);
  is.addRow(['6. Upload the zip file using "Import Episode Data" in the Generate Script dialog.']);

  const buffer = await wb.xlsx.writeBuffer();
  const safeName = (scriptName || 'episode').replace(/[^a-zA-Z0-9]/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${safeName}_requirements.xlsx`);
  res.send(Buffer.from(buffer));
});

app.post('/api/:projectId/import-episode-data',
  express.raw({ type: () => true, limit: '100mb' }),
  async (req, res) => {
    try {
      const zip = new AdmZip(req.body);
      const entries = zip.getEntries();

      // Find the xlsx file
      const xlsxEntry = entries.find(e => e.entryName.endsWith('.xlsx') && !e.entryName.startsWith('__MACOSX'));
      if (!xlsxEntry) return res.status(400).json({ error: 'No .xlsx file found in zip' });

      // Parse xlsx
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsxEntry.getData());
      const ws = wb.getWorksheet(1);

      const requirements = [];
      ws.eachRow((row, rowNum) => {
        if (rowNum === 1) return; // skip header
        const label = row.getCell(2).value?.toString() || '';
        const type = row.getCell(3).value?.toString() || 'text';
        const value = row.getCell(4).value?.toString() || '';
        const filename = row.getCell(5).value?.toString() || '';
        if (!label) return;
        requirements.push({ label, type, value, filename, files: [] });
      });

      // Process media files from zip
      for (const req_item of requirements) {
        if (req_item.type === 'file' && req_item.filename) {
          // Find matching media files in the zip
          const matchingEntries = entries.filter(e => {
            const name = e.entryName.toLowerCase();
            const target = req_item.filename.toLowerCase();
            return (name.includes('media/') || name.includes('media\\')) &&
                   path.basename(name).startsWith(target) &&
                   !name.startsWith('__MACOSX');
          });
          for (const me of matchingEntries) {
            const data = me.getData();
            const ext = path.extname(me.entryName) || '.png';
            const fname = uuidv4().slice(0, 12) + ext;
            fs.writeFileSync(path.join(UPLOAD_DIR, fname), data);
            req_item.files.push(`/uploads/${fname}`);
          }
          req_item.done = req_item.files.length > 0;
        } else {
          req_item.done = !!req_item.value;
        }
      }

      res.json({ requirements });
    } catch (e) {
      res.status(500).json({ error: 'Failed to process zip: ' + e.message });
    }
  }
);

// ─── Production Document Import ─────────────────────────────────────────────
app.post('/api/:projectId/import-doc',
  express.raw({ type: () => true, limit: '50mb' }),
  async (req, res) => {
    try {
      const result = await mammoth.extractRawText({ buffer: req.body });
      res.json({ text: result.value });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse document: ' + e.message });
    }
  }
);

app.post('/api/:projectId/generate-layouts-from-doc', async (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const settings = project.settings || {};
  if (!settings.anthropicApiKey) return res.status(400).json({ error: 'Anthropic API key not set.' });
  setJob(req.params.projectId, 'layouts', 'Analyzing document and generating layouts & graphics...');

  const { docText } = req.body;
  const existingGraphicTypes = ['lower_third', 'message', 'ticker', 'agenda', 'image', 'image_gallery', 'timer', 'score'];

  const systemPrompt = `You are a broadcast production designer. Analyze a production document and create layouts and graphics for a live broadcast.

A layout combines an OBS scene (camera/video background) with overlay graphics shown on top.
Available graphic types: ${existingGraphicTypes.join(', ')}
- lower_third: name + subtitle bar with switchable presets (content: {items:[{title, subtitle}], current:1, size:50}). current is 1-indexed.
- message: alert/banner (content: {text, detail})
- ticker: scrolling text (content: {items:[], speed:60})
- agenda: itemized list/agenda panel (content: {title:'Agenda', items:[], size:50}). Items are one per line; lines starting with "-" are sub-items rendered indented under the previous main item. size is the visual size in percent (20–100, default 50).
- image: display image (content: {url:'', sizing:'contain', library:[]})
- image_gallery: switchable gallery of images (content: {images:[], current:0, sizing:'contain'}). current is 1-indexed; 0 = none shown.
- timer: countdown/clock (content: {mode:'countdown', duration:300, format:'mm:ss', label:''})
- score: scoreboard (content: {team1:{name,score:0,color:'#e63946'}, team2:{name,score:0,color:'#1d3557'}})

Return a JSON object:
{
  "graphics": [{"type":"<type>", "name":"<name>", "content":{...}}],
  "layouts": [{"name":"<layout name>", "obsScene":"<suggested OBS scene name>", "graphicNames":["<graphic name>",...]}]
}

graphicNames references the names of graphics you defined above.
Create all graphics and layouts needed for the production. Be thorough.
Each layout should have an appropriate OBS scene name suggestion.`;

  const userPrompt = `Here is the production document:\n\n${docText}\n\nAnalyze this and generate all layouts and graphics needed.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: settings.aiModel || 'claude-opus-4-6', max_tokens: 16384, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.content?.[0]?.text || '';
    let result;
    try { result = repairJSON(text); } catch(e) {
      return res.status(500).json({ error: 'Could not parse AI response: ' + e.message });
    }

    // Create graphics
    const graphicIdMap = {};
    for (const gDef of (result.graphics || [])) {
      const graphic = {
        id: shortId(),
        type: gDef.type,
        name: gDef.name,
        content: gDef.content || getDefaultContent(gDef.type),
        isLive: false, isCued: false, order: project.graphics.length
      };
      project.graphics.push(graphic);
      graphicIdMap[gDef.name] = graphic.id;
    }

    // Create layouts
    for (const lDef of (result.layouts || [])) {
      const layout = {
        id: shortId(),
        name: lDef.name,
        obsScene: lDef.obsScene || '',
        graphics: (lDef.graphicNames || []).map(name => ({ graphicId: graphicIdMap[name] || '', visible: true })).filter(e => e.graphicId)
      };
      if (!project.layouts) project.layouts = [];
      project.layouts.push(layout);
    }

    saveProject(project);
    io.to(project.id).emit('project:update', project);
    const gc = result.graphics?.length || 0, lc = result.layouts?.length || 0;
    finishJob(req.params.projectId, `Created ${gc} graphics and ${lc} layouts`);
    res.json({ graphicsCreated: gc, layoutsCreated: lc });
  } catch (e) {
    finishJob(req.params.projectId, e.message, true);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/:projectId/generate-formats-from-doc', async (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const settings = project.settings || {};
  if (!settings.anthropicApiKey) return res.status(400).json({ error: 'Anthropic API key not set.' });
  setJob(req.params.projectId, 'formats', 'Analyzing document and generating formats...');

  const { docText } = req.body;

  // Build graphics/layouts context
  const graphicsCtx = project.graphics.map(g => `- "${g.name}" (id:${g.id}, type:${g.type})`).join('\n');
  const layoutsCtx = (project.layouts || []).map(l => `- "${l.name}" (id:${l.id}, obsScene:${l.obsScene})`).join('\n');

  const systemPrompt = `You are a broadcast script format designer. Analyze a production document and create reusable script formats (templates).

A format has steps. Each step has: label, defaultText (template teleprompter text), locked (boolean), and actions.
Action types:
- show: {type:"show", graphicId:"<id>"} — show a graphic
- hide: {type:"hide", graphicId:"<id>"} — hide a graphic
- update: {type:"update", graphicId:"<id>", path:"<field>", value:"<default>"} — update graphic content
- layout: {type:"layout", layoutId:"<id>"} — switch to a layout
- obs: {type:"obs", obsAction:"switch_scene", obsValue:"<scene>"} — OBS action
- wait: {type:"wait", duration:<seconds>} — pause

Available graphics:
${graphicsCtx || '(none yet)'}

Available layouts:
${layoutsCtx || '(none yet)'}

Return a JSON array of formats:
[{
  "name": "<format name>",
  "steps": [{"label":"<step label>", "defaultText":"<template text>", "locked":false, "actions":[...]}]
}]

Create distinct formats for each segment type described in the production document.
Use layout actions where appropriate. Reference real graphic and layout IDs from the lists above.
Mark structural steps (like intros/outros with fixed actions) as locked:true.
IMPORTANT: Keep defaultText brief (1-2 sentences per step). Keep the total response under 12000 characters.`;

  const userPrompt = `Here is the production document:\n\n${docText}\n\nGenerate all script formats needed for this production.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: settings.aiModel || 'claude-opus-4-6', max_tokens: 16384, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.content?.[0]?.text || '';
    let formats;
    try { formats = repairJSON(text); } catch(e) {
      return res.status(500).json({ error: 'Could not parse AI response: ' + e.message });
    }
    if (!Array.isArray(formats)) formats = formats.formats || [formats];

    if (!project.formats) project.formats = [];
    for (const fDef of formats) {
      project.formats.push({
        id: shortId(),
        name: fDef.name,
        steps: (fDef.steps || []).map(s => ({
          id: shortId(),
          label: s.label || '',
          defaultText: s.defaultText || '',
          locked: s.locked || false,
          actions: s.actions || []
        }))
      });
    }

    saveProject(project);
    io.to(project.id).emit('project:update', project);
    finishJob(req.params.projectId, `Created ${formats.length} formats`);
    res.json({ formatsCreated: formats.length });
  } catch (e) {
    finishJob(req.params.projectId, e.message, true);
    res.status(500).json({ error: e.message });
  }
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
  express.raw({ type: ['image/*', 'audio/*', 'video/*'], limit: '50mb' }),
  (req, res) => {
    const contentType = req.headers['content-type'] || '';
    const extMap = {
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
      'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/aac': '.aac', 'audio/m4a': '.m4a',
      'video/mp4': '.mp4', 'video/webm': '.webm'
    };
    const ext = extMap[contentType] || (contentType.startsWith('audio/') ? '.mp3' : contentType.startsWith('video/') ? '.mp4' : '.png');
    const filename = uuidv4().slice(0, 12) + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.body);
    res.json({ url: `/uploads/${filename}` });
  }
);

// ─── Graphic position (REST) ────────────────────────────────────────────────
app.post('/api/:projectId/graphic/:graphicId/position', (req, res) => {
  const project = loadProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const g = project.graphics.find(g => g.id === req.params.graphicId);
  if (!g) return res.status(404).json({ error: 'Graphic not found' });
  const { x, y, slot } = req.body;
  const position = { x, y };
  if (slot === 'solo') g.positionSolo = position;
  else g.position = position;
  saveProject(project);
  io.to(project.id).emit('graphic:reposition', { graphicId: g.id, position, slot: slot || null });
  res.json({ ok: true });
});

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

app.post('/api/obs/test-scenes', async (req, res) => {
  if (!obsConnected) return res.json({ connected: false, results: {} });
  try {
    const { scenes: obsScenes } = await obs.call('GetSceneList');
    const available = new Set(obsScenes.map(s => s.sceneName));
    const results = {};
    for (const name of (req.body.scenes || [])) {
      results[name] = available.has(name);
    }
    res.json({ connected: true, results });
  } catch (e) { res.json({ connected: false, error: e.message, results: {} }); }
});

app.get('/api/obs/inputs', async (req, res) => {
  if (!obsConnected) return res.json({ inputs: [] });
  try {
    const { inputs } = await obs.call('GetInputList');
    res.json({ inputs: inputs.map(i => i.inputName) });
  } catch (e) { res.json({ inputs: [], error: e.message }); }
});

// ─── Social comments: sessions, connectors, and logging ───────────────────
const socialSessions = new Map(); // graphicId -> session
const socialConnectorCache = {};

function getSocialConnector(platform) {
  if (socialConnectorCache[platform] !== undefined) return socialConnectorCache[platform];
  const p = path.join(__dirname, 'sources', `${platform}.js`);
  if (!fs.existsSync(p)) { socialConnectorCache[platform] = null; return null; }
  try { socialConnectorCache[platform] = require(p); }
  catch (e) { console.warn(`[social] failed to load ${platform}:`, e.message); socialConnectorCache[platform] = null; }
  return socialConnectorCache[platform];
}

function socialConfigKey(g) {
  return (g.content?.sources || [])
    .filter(s => s && s.enabled !== false && s.ref)
    .map(s => `${s.platform}:${String(s.ref).trim().toLowerCase()}`)
    .sort().join('|');
}

function reconcileSocialSessions(project) {
  if (!project || !project.graphics) return;
  const liveIds = new Set();
  for (const g of project.graphics) {
    if (g.type !== 'social_comment') continue;
    liveIds.add(g.id);
    const existing = socialSessions.get(g.id);
    const newKey = socialConfigKey(g);
    if (!existing) {
      if (newKey) startSocialSession(project.id, g);
    } else if (existing.configKey !== newKey) {
      stopSocialSession(g.id);
      if (newKey) startSocialSession(project.id, g);
    }
  }
  for (const gid of Array.from(socialSessions.keys())) {
    const sess = socialSessions.get(gid);
    if (sess.projectId === project.id && !liveIds.has(gid)) stopSocialSession(gid);
  }
}

function startSocialSession(projectId, g) {
  const sess = {
    projectId, graphicId: g.id,
    connectors: [],
    incomingBuffer: [], // newest first, capped
    pending: [],        // newest first, capped
    holdTimers: new Map(),
    configKey: socialConfigKey(g)
  };
  socialSessions.set(g.id, sess);
  for (const s of g.content.sources || []) {
    if (!s || s.enabled === false || !s.ref) continue;
    const mod = getSocialConnector(s.platform);
    if (!mod) { console.warn(`[social] no connector for ${s.platform}`); continue; }
    try {
      const handle = mod(s, {
        onComment: (c) => handleIncomingComment(g.id, c),
        onError: (e) => console.warn(`[social ${s.platform}:${s.ref}] ${e?.message || e}`),
        onStatus: () => {}
      });
      sess.connectors.push({ source: s, handle });
    } catch (e) {
      console.warn(`[social] ${s.platform} start failed:`, e.message);
    }
  }
}

function stopSocialSession(gid) {
  const sess = socialSessions.get(gid);
  if (!sess) return;
  for (const c of sess.connectors) { try { c.handle?.stop?.(); } catch {} }
  for (const t of sess.holdTimers.values()) clearTimeout(t);
  socialSessions.delete(gid);
}

function logSocialComment(projectId, graphicId, comment) {
  try {
    const dir = path.join(DATA_DIR, 'comments', projectId, graphicId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, `${date}.jsonl`), JSON.stringify(comment) + '\n');
  } catch (e) { /* non-fatal */ }
}

function handleIncomingComment(gid, comment) {
  const sess = socialSessions.get(gid);
  if (!sess) return;
  // Dedupe
  if (sess.incomingBuffer.some(c => c.id === comment.id)) return;
  sess.incomingBuffer.unshift(comment);
  if (sess.incomingBuffer.length > 100) sess.incomingBuffer.length = 100;
  logSocialComment(sess.projectId, gid, comment);

  const project = loadProject(sess.projectId);
  if (!project) return;
  const g = project.graphics.find(x => x.id === gid);
  if (!g) return;

  io.to(sess.projectId).emit('comments:new', { graphicId: gid, comment });

  const mode = g.content.moderation || 'auto';
  if (mode === 'approval') {
    sess.pending.unshift(comment);
    if (sess.pending.length > 50) sess.pending.length = 50;
  } else {
    pushCommentToAir(project, g, comment);
  }
}

function pushCommentToAir(project, g, comment) {
  g.content.current = g.content.current || [];
  if (g.content.current.some(c => c.id === comment.id)) return;
  g.content.current.unshift(comment);
  const max = Math.max(1, g.content.maxVisible || 3);
  while (g.content.current.length > max) g.content.current.pop();
  // Write without triggering reconcile (avoid useless diffing)
  fs.writeFileSync(projectPath(project.id), JSON.stringify(project, null, 2));
  if (g.isLive) io.to(project.id).emit('graphic:update', g);
  io.to(project.id).emit('project:update', project);

  const sess = socialSessions.get(g.id);
  if (!sess) return;
  const holdSec = g.content.displayMode === 'rotate'
    ? (g.content.rotateSec || 8)
    : (g.content.holdSec || 10);
  if (holdSec > 0) {
    const t = setTimeout(() => dropCommentFromAir(g.id, comment.id), holdSec * 1000);
    sess.holdTimers.set(comment.id, t);
  }
}

function dropCommentFromAir(gid, commentId) {
  const sess = socialSessions.get(gid);
  if (sess) {
    const existing = sess.holdTimers.get(commentId);
    if (existing) { clearTimeout(existing); sess.holdTimers.delete(commentId); }
  }
  const projectId = sess?.projectId;
  if (!projectId) return;
  const project = loadProject(projectId);
  if (!project) return;
  const g = project.graphics.find(x => x.id === gid);
  if (!g) return;
  const before = (g.content.current || []).length;
  g.content.current = (g.content.current || []).filter(c => c.id !== commentId);
  if (g.content.current.length === before) return;
  fs.writeFileSync(projectPath(project.id), JSON.stringify(project, null, 2));
  if (g.isLive) io.to(project.id).emit('graphic:update', g);
  io.to(project.id).emit('project:update', project);
}

// Graceful shutdown
process.on('SIGINT', () => { for (const id of Array.from(socialSessions.keys())) stopSocialSession(id); process.exit(0); });
process.on('SIGTERM', () => { for (const id of Array.from(socialSessions.keys())) stopSocialSession(id); process.exit(0); });

// ─── Socket.IO ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('obs:status', { connected: obsConnected });
  socket.on('join', (projectId) => {
    socket.join(projectId);
    const project = loadProject(projectId);
    if (project) {
      socket.emit('project:update', project);
      try { reconcileSocialSessions(project); } catch (e) { console.warn('[social] reconcile error:', e.message); }
    }
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

  // Also handle via REST as fallback (iframes may have socket issues)
  // (REST endpoint is defined above)

  socket.on('graphic:position', ({ projectId, graphicId, position, slot }) => {
    const project = loadProject(projectId);
    if (!project) return;
    const g = project.graphics.find(g => g.id === graphicId);
    if (!g) return;
    if (slot === 'solo') g.positionSolo = position;
    else g.position = position;
    saveProject(project);
    // Broadcast position to all other output/preview windows
    socket.to(projectId).emit('graphic:reposition', { graphicId, position, slot: slot || null });
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

  // ─── Social comments ─────────────────────────────────────────────────
  socket.on('comments:subscribe', ({ projectId, graphicId }) => {
    socket.join(projectId);
    const sess = socialSessions.get(graphicId);
    if (!sess) return;
    // Replay recent incoming so the operator's feed populates on reconnect
    for (const c of sess.incomingBuffer.slice(0, 30).reverse()) {
      socket.emit('comments:new', { graphicId, comment: c });
    }
  });

  socket.on('comments:unsubscribe', () => { /* stateless — no per-socket tracking */ });

  socket.on('comments:push', ({ projectId, graphicId, commentId }) => {
    const sess = socialSessions.get(graphicId);
    if (!sess) return;
    const comment = sess.incomingBuffer.find(c => c.id === commentId);
    if (!comment) return;
    const project = loadProject(projectId);
    if (!project) return;
    const g = project.graphics.find(x => x.id === graphicId);
    if (!g) return;
    pushCommentToAir(project, g, comment);
  });

  socket.on('comments:approve', ({ projectId, graphicId, commentId }) => {
    const sess = socialSessions.get(graphicId);
    if (!sess) return;
    const idx = sess.pending.findIndex(c => c.id === commentId);
    if (idx < 0) return;
    const [comment] = sess.pending.splice(idx, 1);
    io.to(projectId).emit('comments:pending-drop', { graphicId, commentId });
    const project = loadProject(projectId);
    if (!project) return;
    const g = project.graphics.find(x => x.id === graphicId);
    if (!g) return;
    pushCommentToAir(project, g, comment);
  });

  socket.on('comments:reject', ({ projectId, graphicId, commentId }) => {
    const sess = socialSessions.get(graphicId);
    if (!sess) return;
    sess.pending = sess.pending.filter(c => c.id !== commentId);
    io.to(projectId).emit('comments:pending-drop', { graphicId, commentId });
  });

  socket.on('comments:drop', ({ projectId, graphicId, commentId }) => {
    dropCommentFromAir(graphicId, commentId);
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
      // Layout
      if (action.type === 'layout') {
        const layout = (project.layouts || []).find(l => l.id === action.layoutId);
        if (!layout) return;
        // Switch OBS scene
        if (layout.obsScene && obsConnected) {
          await obs.call('SetCurrentProgramScene', { sceneName: layout.obsScene }).catch(() => {});
        }
        // Show/hide graphics
        for (const entry of (layout.graphics || [])) {
          const g = project.graphics.find(g => g.id === entry.graphicId);
          if (!g) continue;
          if (entry.visible && !g.isLive) {
            g.isLive = true; g.isCued = false;
            io.to(projectId).emit('graphic:show', g);
          } else if (!entry.visible && g.isLive) {
            g.isLive = false; g.isCued = false;
            io.to(projectId).emit('graphic:hide', g);
          }
        }
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
      return { items: [{ title: 'Name', subtitle: 'Title / Company' }], current: 1, size: 50 };
    case 'message':
      return { header: 'ALERT', text: 'Breaking News', detail: 'Details here...', size: 50 };
    case 'ticker':
      return { items: ['Item 1', 'Item 2', 'Item 3'], speed: 60 };
    case 'agenda':
      return { title: 'Agenda', items: ['Welcome', 'Main Topic', '- Key points', '- Discussion', 'Q&A'], size: 50, sizeSolo: 50, currentItem: 0, solo: false, soloShowHeading: false, soloShowItem: true };
    case 'image':
      return { url: '', sizing: 'contain', library: [], size: 50, shadow: true };
    case 'image_gallery':
      return { images: [], current: 0, sizing: 'contain' };
    case 'timer':
      return { mode: 'countdown', duration: 300, format: 'mm:ss', label: 'Timer', size: 50 };
    case 'score':
      return {
        team1: { name: 'Team A', score: 0, color: '#e63946' },
        team2: { name: 'Team B', score: 0, color: '#1d3557' }
      };
    case 'social_comment':
      return {
        sources: [],
        moderation: 'auto',
        displayMode: 'queue',
        maxVisible: 3,
        rotateSec: 8,
        holdSec: 10,
        current: [],
        showAvatar: true,
        showPlatformBadge: true,
        size: 50
      };
    default:
      return {};
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
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
  console.log(`  │  Local:   http://${HOST}:${PORT}/        │`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log(`  │  Network: http://${localIP}:${PORT}/  │`);
  }
  console.log(`  └──────────────────────────────────────────┘\n`);
});
