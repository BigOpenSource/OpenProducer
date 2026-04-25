// Twitch chat connector — anonymous IRC over WebSocket.
// No API key required.
// config: { ref }  — ref is the channel name (e.g. "xqc")

module.exports = function start(config, { onComment, onError, onStatus }) {
  const channel = String(config.ref || '').trim().toLowerCase().replace(/^#/, '');
  if (!channel) {
    onError?.(new Error('Twitch: missing channel'));
    return { stop() {} };
  }

  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  const anonNick = 'justinfan' + Math.floor(10000 + Math.random() * 80000);

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    } catch (e) {
      onError?.(e);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      ws.send('CAP REQ :twitch.tv/tags');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK ${anonNick}`);
      ws.send(`JOIN #${channel}`);
      onStatus?.({ connected: true });
    });

    ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      for (const line of data.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG ' + line.slice(5)); continue; }
        const msg = parseIrcLine(line);
        if (msg && msg.command === 'PRIVMSG') {
          const tags = msg.tags || {};
          onComment?.({
            id: tags['id'] || `tw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            platform: 'twitch',
            author: tags['display-name'] || msg.nick || 'unknown',
            authorAvatar: null,
            text: msg.trailing || '',
            timestamp: tags['tmi-sent-ts']
              ? new Date(+tags['tmi-sent-ts']).toISOString()
              : new Date().toISOString(),
            raw: { channel, tags }
          });
        }
      }
    });

    ws.addEventListener('close', () => {
      onStatus?.({ connected: false });
      scheduleReconnect();
    });

    ws.addEventListener('error', (e) => {
      onError?.(e?.error || new Error('Twitch WS error'));
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
      try { ws?.close(); } catch {}
    }
  };
};

function parseIrcLine(line) {
  let rest = line;
  let tags = null;
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    const tagStr = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    tags = {};
    for (const kv of tagStr.split(';')) {
      const eq = kv.indexOf('=');
      if (eq < 0) tags[kv] = true;
      else tags[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  let prefix = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const trailIdx = rest.indexOf(' :');
  let trailing = null;
  let head = rest;
  if (trailIdx >= 0) {
    trailing = rest.slice(trailIdx + 2);
    head = rest.slice(0, trailIdx);
  }
  const parts = head.split(' ');
  const command = parts[0];
  const nick = prefix ? prefix.split('!')[0] : null;
  return { tags, prefix, nick, command, params: parts.slice(1), trailing };
}
