// api/requests.js
// Vercel serverless function — fetches @marina-mpms tagged kit requests from Slack

const CHANNEL_ID   = 'C09QE0SBQCQ';  // #part-requests-marina
const MARINA_GROUP = 'S0A1KD34YAH';   // @marina-mpms user group ID
const SLACK_TOKEN  = process.env.SLACK_BOT_TOKEN;

async function slackGet(path, params = {}) {
  const url = new URL(`https://slack.com/api/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  return res.json();
}

async function fetchChannelMessages() {
  const msgs = [];
  let cursor;
  for (let i = 0; i < 2; i++) {
    const data = await slackGet('conversations.history', {
      channel: CHANNEL_ID,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!data.ok) break;
    msgs.push(...(data.messages || []));
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return msgs;
}

async function fetchThread(ts) {
  const data = await slackGet('conversations.replies', {
    channel: CHANNEL_ID,
    ts,
    limit: 50,
  });
  return data.messages || [];
}

// Extract all text recursively from message including blocks
function extractAllText(msg) {
  const parts = [];
  if (msg.text) parts.push(msg.text);
  function walk(blocks) {
    if (!blocks) return;
    for (const b of blocks) {
      if (b.text?.text) parts.push(b.text.text);
      if (b.text && typeof b.text === 'string') parts.push(b.text);
      if (b.fields) b.fields.forEach(f => f.text && parts.push(f.text));
      if (b.elements) walk(b.elements);
      if (b.blocks)   walk(b.blocks);
    }
  }
  walk(msg.blocks);
  if (msg.attachments) {
    msg.attachments.forEach(a => {
      if (a.text) parts.push(a.text);
      if (a.fallback) parts.push(a.fallback);
      walk(a.blocks || []);
    });
  }
  return parts.join('\n');
}

function extractTicketId(text) {
  return text?.match(/IVJN-\d+/i)?.[0]?.toUpperCase() || null;
}

function extractRequesterId(text) {
  const m = text?.match(/Requester[^<\n]*[\n\r]*<@([A-Z0-9]+)/i);
  return m?.[1] || null;
}

function parseLabel(text, label) {
  if (!text) return null;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}[^\\n]*[\\n\\r]+([^\\n*<]{1,60})`, 'i');
  const m  = text.match(re);
  if (m?.[1]) {
    return m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\*/g, '')
      .trim()
      .slice(0, 60) || null;
  }
  return null;
}

function parsePriority(text) {
  if (!text) return 'asready';
  if (/line.?down|:alert:/i.test(text)) return 'linedown';
  if (/asap/i.test(text))               return 'asap';
  return 'asready';
}

function deriveStatus(replies) {
  const text = replies.map(r => extractAllText(r)).join('\n').toLowerCase();
  if (/staged|complete|courier|pick.?up rack|outbound rack|handed to courier/i.test(text)) return 'done';
  if (/:approved:|approved|\u2705/i.test(text)) return 'approved';
  if (/cancel/i.test(text))                     return 'cancelled';
  return 'pending';
}

function extractThreadNote(replies) {
  const human = replies.slice(1).find(r => {
    const t = extractAllText(r);
    return r.user && t.length > 15 &&
      !t.includes('Please review this kit request') &&
      !t.includes('marina-mpms');
  });
  if (!human) return null;
  return extractAllText(human)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function buildPermalink(ts) {
  return `https://jobyaviation.slack.com/archives/${CHANNEL_ID}/p${ts.replace('.', '')}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (!SLACK_TOKEN) {
    return res.status(500).json({ error: 'SLACK_BOT_TOKEN not set' });
  }

  try {
    // Step 1 — fetch messages
    const messages = await fetchChannelMessages();

    // Step 2 — filter to kit requests with IVJN ticket IDs
    const kitRequests = messages.filter(m => {
      const t = extractAllText(m);
      return t.includes('IVJN-');
    });

    // Step 3 — fetch threads for first 12 only to avoid timeout
    const limited = kitRequests.slice(0, 12);
    const threads = await Promise.all(limited.map(m => fetchThread(m.ts)));

    // Step 4 — filter to those with @marina-mpms tagged in thread
    const marinaOnly = limited.reduce((acc, msg, i) => {
      const threadText = threads[i].map(r => extractAllText(r)).join('\n');
      // Check for group ID or text mention
      if (threadText.includes(MARINA_GROUP) || threadText.includes('marina-mpms')) {
        acc.push({ msg, replies: threads[i] });
      }
      return acc;
    }, []);

    // Step 5 — collect user IDs to resolve (max 10)
    const userIds = [...new Set(
      marinaOnly
        .map(({ msg }) => extractRequesterId(extractAllText(msg)))
        .filter(Boolean)
    )].slice(0, 10);

    // Step 6 — resolve user names in parallel
    const userMap = {};
    await Promise.all(userIds.map(async id => {
      try {
        const data = await slackGet('users.info', { user: id });
        userMap[id] = data.ok
          ? (data.user?.profile?.display_name_normalized ||
             data.user?.profile?.real_name ||
             data.user?.name || id)
          : id;
      } catch { userMap[id] = id; }
    }));

    // Step 7 — build results
    const results = marinaOnly.map(({ msg, replies }) => {
      const full      = extractAllText(msg);
      const userId    = extractRequesterId(full);
      const requester = userId ? (userMap[userId] || userId) : 'Unknown';
      return {
        id:             extractTicketId(full) || msg.ts,
        requester,
        timestamp:      new Date(parseFloat(msg.ts) * 1000).toISOString(),
        priority:       parsePriority(full),
        warehouse:      parseLabel(full, 'Destination Warehouse') || '—',
        location:       parseLabel(full, 'Destination Location')  || '—',
        dateNeeded:     parseLabel(full, 'Date Needed')            || '—',
        status:         deriveStatus(replies),
        threadActivity: extractThreadNote(replies),
        threadUrl:      buildPermalink(msg.ts),
        replyCount:     Math.max(0, replies.length - 1),
      };
    });

    // Sort: linedown first, then asap, then asready, newest first
    const order = { linedown: 0, asap: 1, asready: 2 };
    results.sort((a, b) =>
      (order[a.priority] - order[b.priority]) ||
      (new Date(b.timestamp) - new Date(a.timestamp))
    );

    res.status(200).json({
      requests:  results,
      fetchedAt: new Date().toISOString(),
      total:     results.length,
    });

  } catch (err) {
    console.error('API Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}