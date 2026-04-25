// X (Twitter) connector — polls replies to a post via v2 recent search.
// Requires env X_BEARER_TOKEN. Basic tier or above.
// config: { ref } — ref is the post/tweet id.

module.exports = function start(config, { onComment, onError, onStatus }) {
  const postId = String(config.ref || '').trim();
  const bearer = process.env.X_BEARER_TOKEN;
  if (!postId) { onError?.(new Error('X: missing postId')); return { stop() {} }; }
  if (!bearer) { onError?.(new Error('X: X_BEARER_TOKEN not set')); return { stop() {} }; }

  let stopped = false;
  let nextPollTimer = null;
  let sinceId = null;
  let firstPoll = true;
  const userCache = new Map();

  async function poll() {
    if (stopped) return;
    try {
      const params = new URLSearchParams({
        query: `conversation_id:${postId}`,
        'tweet.fields': 'created_at,author_id',
        expansions: 'author_id',
        'user.fields': 'name,username,profile_image_url',
        max_results: '50'
      });
      if (sinceId) params.set('since_id', sinceId);
      const r = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
        headers: { Authorization: `Bearer ${bearer}` }
      });
      if (!r.ok) {
        if (r.status === 429) throw new Error('X: rate limited');
        if (r.status === 401) throw new Error('X: bearer token invalid');
        throw new Error(`X recent search ${r.status}`);
      }
      const j = await r.json();
      for (const u of j.includes?.users || []) userCache.set(u.id, u);
      if (j.meta?.newest_id) sinceId = j.meta.newest_id;
      const tweets = j.data || [];
      onStatus?.({ connected: true });
      // Skip backlog on first poll so we only surface new comments.
      if (!firstPoll) {
        // Return oldest-first for natural reading order
        for (const t of tweets.slice().reverse()) {
          const u = userCache.get(t.author_id) || {};
          onComment?.({
            id: t.id,
            platform: 'x',
            author: u.name ? `${u.name} (@${u.username})` : (u.username || 'unknown'),
            authorAvatar: u.profile_image_url || null,
            text: t.text || '',
            timestamp: t.created_at || new Date().toISOString(),
            raw: { postId }
          });
        }
      }
      firstPoll = false;
      nextPollTimer = setTimeout(poll, 12000);
    } catch (e) {
      onError?.(e);
      onStatus?.({ connected: false });
      nextPollTimer = setTimeout(poll, 30000);
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
