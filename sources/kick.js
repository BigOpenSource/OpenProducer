// Kick chat connector — unofficial Pusher WebSocket.
// No API key required (may break if Kick changes endpoints).
// config: { ref } — ref is the channel slug (e.g. "xqc").

const KICK_PUSHER_KEY = '32cbd69e4b950bf97679';
const KICK_PUSHER_CLUSTER = 'us2';

module.exports = function start(config, { onComment, onError, onStatus }) {
  const channelSlug = String(config.ref || '').trim().toLowerCase();
  if (!channelSlug) { onError?.(new Error('Kick: missing channel')); return { stop() {} }; }

  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let chatroomId = null;
  let pingTimer = null;

  async function resolveChatroomId() {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channelSlug)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error(`Kick channel lookup ${r.status}`);
    const j = await r.json();
    const id = j?.chatroom?.id;
    if (!id) throw new Error('Kick: chatroom id not found');
    return id;
  }

  async function connect() {
    if (stopped) return;
    try {
      if (!chatroomId) chatroomId = await resolveChatroomId();
      const url = `wss://ws-${KICK_PUSHER_CLUSTER}.pusher.com/app/${KICK_PUSHER_KEY}?protocol=7&client=js&version=7.6.0&flash=false`;
      ws = new WebSocket(url);
    } catch (e) {
      onError?.(e);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: `chatrooms.${chatroomId}.v2` }
      }));
      pingTimer = setInterval(() => {
        try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch {}
      }, 30000);
      onStatus?.({ connected: true });
    });

    ws.addEventListener('message', (ev) => {
      let frame;
      try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (frame.event === 'App\\Events\\ChatMessageEvent') {
        let payload;
        try { payload = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data; } catch { return; }
        onComment?.({
          id: payload.id || `kick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          platform: 'kick',
          author: payload.sender?.username || 'unknown',
          authorAvatar: payload.sender?.identity?.avatar || null,
          text: payload.content || '',
          timestamp: payload.created_at || new Date().toISOString(),
          raw: { channelSlug, chatroomId }
        });
      }
    });

    ws.addEventListener('close', () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      onStatus?.({ connected: false });
      scheduleReconnect();
    });

    ws.addEventListener('error', (e) => {
      onError?.(e?.error || new Error('Kick WS error'));
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      try { ws?.close(); } catch {}
    }
  };
};
