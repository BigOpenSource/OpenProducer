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
    scripts: []
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
    for (const action of actions) {
      // OBS actions
      if (action.type === 'obs') {
        await executeOBSAction(action);
        continue;
      }
      // Graphic actions
      const g = project.graphics.find(g => g.id === action.graphicId);
      if (!g) continue;
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
