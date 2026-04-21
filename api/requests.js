// api/requests.js
// Vercel serverless function — fetches RNDCONSUME kit requests from Slack

const CHANNEL_ID  = 'C09QE0SBQCQ'; // #part-requests-marina
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;

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
  for (let i = 0; i < 4; i++) {
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
    limit: 100,
  });
  return data.messages || [];
}

function extractAllText(msg) {
  const parts = [];
  if (msg.text) parts.push(msg.text);
  function walk(blocks) {
    if (!blocks) return;
    for (const b of blocks) {
      if (b.text?.text) parts.push(b.text.text);
      if (typeof b.text === 'string') parts.push(b.text);
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
  const m = text?.match(/Requester[^<\n]*[\n\r]*.*?<@([A-Z0-9]+)/is);
  return m?.[1] || null;
}

function parseLabel(text, label) {
  if (!text) return null;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re  = new RegExp(`${esc}[^\\n]*[\\n\\r]+([^\\n*<]{1,60})`, 'i');
  const m   = text.match(re);
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
  if (/staged|complete|courier|pick.?up rack|outbound rack|handed to courier|transfer rack|transfer pick|now complete|ready for pickup|fulfilled|sent out|delivered|kitted/i.test(text)) return 'done';
  if (/:approved:|approved|\u2705|looks good|good to go|confirmed|permission granted/i.test(text)) return 'approved';
  if (/cancel/i.test(text)) return 'cancelled';
  return 'pending';
}

function extractThreadNote(replies) {
  const seen = new Set();
  const human = replies.slice(1).find(r => {
    const t = extractAllText(r);
    if (seen.has(t)) return false;
    seen.add(t);
    return r.user &&
      t.length > 15 &&
      !t.includes('Please review this kit request') &&
      !t.includes('marina-mpms') &&
      !t.includes('New Kit Request');
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
    const messages = await fetchChannelMessages();

    // Filter to RNDCONSUME kit requests from last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const rndRequests = messages.filter(m => {
      const t  = extractAllText(m); // checks text AND blocks
      const ts = parseFloat(m.ts) * 1000;
      return (t.includes('IVJN-') || JSON.stringify(m.blocks || '').includes('IVJN-')) &&
             (t.includes('RNDCONSUME') || JSON.stringify(m.blocks || '').includes('RNDCONSUME')) &&
             ts > sevenDaysAgo;
    });

    // Limit to 20 to avoid Vercel timeout
    const limited = rndRequests.slice(0, 20);

    // Fetch threads in parallel
    const threads = await Promise.all(limited.map(m => fetchThread(m.ts)));

    // Collect unique user IDs
    const userIds = [...new Set(
      limited
        .map(m => extractRequesterId(extractAllText(m)))
        .filter(Boolean)
    )].slice(0, 20);

    // Resolve user names in parallel
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

    // Build results
    const results = limited.map((msg, i) => {
      const full      = extractAllText(msg);
      const userId    = extractRequesterId(full);
      const requester = userId ? (userMap[userId] || userId) : 'Unknown';
      return {
        id:             extractTicketId(full) || msg.ts,
        requester,
        timestamp:      new Date(parseFloat(msg.ts) * 1000).toISOString(),
        priority:       parsePriority(full),
        warehouse:      parseLabel(full, 'Destination Warehouse') || '—',
        location:       'RNDCONSUME',
        dateNeeded:     parseLabel(full, 'Date Needed') || '—',
        status:         deriveStatus(threads[i]),
        threadActivity: extractThreadNote(threads[i]),
        threadUrl:      buildPermalink(msg.ts),
        replyCount:     Math.max(0, threads[i].length - 1),
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