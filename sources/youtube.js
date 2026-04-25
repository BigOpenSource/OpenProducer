// YouTube Live chat connector — Data API v3 polling.
// Requires env YOUTUBE_API_KEY.
// config: { ref }  — ref is the live stream videoId.

module.exports = function start(config, { onComment, onError, onStatus }) {
  const videoId = String(config.ref || '').trim();
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!videoId) { onError?.(new Error('YouTube: missing videoId')); return { stop() {} }; }
  if (!apiKey) { onError?.(new Error('YouTube: YOUTUBE_API_KEY not set')); return { stop() {} }; }

  let stopped = false;
  let liveChatId = null;
  let pageToken = null;
  let nextPollTimer = null;
  let firstPoll = true;

  async function resolveLiveChatId() {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`YouTube videos.list ${r.status}`);
    const j = await r.json();
    const id = j.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!id) throw new Error('YouTube: no active live chat (stream offline or not a live broadcast)');
    return id;
  }

  async function poll() {
    if (stopped) return;
    try {
      if (!liveChatId) {
        liveChatId = await resolveLiveChatId();
        onStatus?.({ connected: true });
      }
      const params = new URLSearchParams({
        liveChatId,
        part: 'id,snippet,authorDetails',
        key: apiKey
      });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await fetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?${params}`);
      if (!r.ok) {
        if (r.status === 403) throw new Error('YouTube: quota exceeded or key invalid');
        if (r.status === 404) { liveChatId = null; throw new Error('YouTube: live chat ended'); }
        throw new Error(`YouTube liveChat ${r.status}`);
      }
      const j = await r.json();
      pageToken = j.nextPageToken || null;
      const items = j.items || [];
      // Skip the first poll's historical backlog — only want new comments going forward.
      if (!firstPoll) {
        for (const m of items) {
          const text = m.snippet?.displayMessage || m.snippet?.textMessageDetails?.messageText || '';
          if (!text) continue;
          onComment?.({
            id: m.id,
            platform: 'youtube',
            author: m.authorDetails?.displayName || 'unknown',
            authorAvatar: m.authorDetails?.profileImageUrl || null,
            text,
            timestamp: m.snippet?.publishedAt || new Date().toISOString(),
            raw: { videoId }
          });
        }
      }
      firstPoll = false;
      const delay = Math.max(2000, j.pollingIntervalMillis || 5000);
      nextPollTimer = setTimeout(poll, delay);
    } catch (e) {
      onError?.(e);
      onStatus?.({ connected: false });
      nextPollTimer = setTimeout(poll, 15000);
    }
  }

  poll();

  return {
    stop() {
      stopped = true;
      if (nextPollTimer) { clearTimeout(nextPollTimer); nextPollTimer = null; }
    }
  };
};
