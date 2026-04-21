// api/requests.js
// Vercel serverless function — fetches @marina-mpms tagged kit requests from Slack

const CHANNEL_ID   = 'C09QE0SBQCQ';  // #part-requests-marina
const MARINA_GROUP = 'S0A1KD34YAH';   // @marina-mpms user group ID
const SLACK_TOKEN  = process.env.SLACK_BOT_TOKEN;

// ── Slack API helper ───────────────────────────────────────────────────────
async function slackGet(path, params = {}) {
  const url = new URL(`https://slack.com/api/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  return res.json();
}

// ── Fetch last 200 messages ────────────────────────────────────────────────
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

// ── Fetch thread replies ───────────────────────────────────────────────────
async function fetchThread(ts) {
  const data = await slackGet('conversations.replies', {
    channel: CHANNEL_ID,
    ts,
    limit: 50,
  });
  return data.messages || [];
}

// ── Fetch user display names in one batch ─────────────────────────────────
async function buildUserMap(userIds) {
  const map = {};
  // Fetch up to 20 users in parallel to stay within timeout
  const unique = [...new Set(userIds)].slice(0, 20);
  await Promise.all(unique.map(async (id) => {
    try {
      const data = await slackGet('users.info', { user: id });
      if (data.ok && data.user) {
        map[id] =
          data.user.profile?.display_name_normalized ||
          data.user.profile?.display_name ||
          data.user.profile?.real_name ||
          data.user.real_name ||
          data.user.name ||
          id;
      } else {
        map[id] = id;
      }
    } catch {
      map[id] = id;
    }
  }));
  return map;
}

// ── Extract all text from a Slack message (blocks + text) ─────────────────
function extractAllText(msg) {
  const parts = [];
  if (msg.text) parts.push(msg.text);
  function walkBlocks(blocks) {
    if (!blocks) return;
    for (const block of blocks) {
      if (block.text?.text) parts.push(block.text.text);
      if (block.fields) block.fields.forEach(f => f.text && parts.push(f.text));
      if (block.elements) walkBlocks(block.elements);
      if (block.blocks)   walkBlocks(block.blocks);
    }
  }
  walkBlocks(msg.blocks);
  if (msg.attachments) walkBlocks(msg.attachments.flatMap(a => a.blocks || []));
  return parts.join('\n');
}

// ── Parse helpers ──────────────────────────────────────────────────────────
function extractTicketId(text) {
  return text?.match(/IVJN-\d+/i)?.[0]?.toUpperCase() || null;
}

function extractRequesterId(text) {
  if (!text) return null;
  const m = text.match(/\*Requester:\*\s*[\n\r]+<@([A-Z0-9]+)(?:\|[^>]*)?>/);
  return m?.[1] || null;
}

function parseLabel(text, label) {
  if (!text) return null;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\*?${esc}:?\\*?\\s*\\n([^\\n*]{1,80})`),
    new RegExp(`\\*?${esc}:?\\*?\\s+([^\\n*<]{1,80})`),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const clean = m[1]
        .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '$1')
        .replace(/<mailto:[^|]+\|([^>]+)>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .trim();
      if (clean.length > 0 && clean.length < 80) return clean;
    }
  }
  return null;
}

function parsePriority(text) {
  if (!text) return 'asready';
  if (/line.?down|alert/i.test(text)) return 'linedown';
  if (/asap/i.test(text))             return 'asap';
  return 'asready';
}

function deriveStatus(replies) {
  const text = replies.map(r => extractAllText(r)).join('\n').toLowerCase();
  if (/staged|complete|courier|pick.?up rack|outbound rack|handed to courier/i.test(text)) return 'done';
  if (/:approved:|approved|✅/i.test(text)) return 'approved';
  if (/cancel/i.test(text))                 return 'cancelled';
  return 'pending';
}

function extractThreadNote(replies) {
  const human = replies.slice(1).find(r => {
    const t = extractAllText(r);
    return r.user &&
      t.length > 15 &&
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

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (!SLACK_TOKEN) {
    return res.status(500).json({ error: 'SLACK_BOT_TOKEN not set' });
  }

  try {
    // Verify channel access
    const channelInfo = await slackGet('conversations.info', { channel: CHANNEL_ID });
    if (!channelInfo.ok) {
      return res.status(200).json({
        error: channelInfo.error,
        fix: channelInfo.error === 'not_in_channel'
          ? 'Type /invite @MPM Dashboard in #part-requests-marina'
          : 'Check your SLACK_BOT_TOKEN in Vercel environment variables',
      });
    }

    // Fetch messages
    const messages = await fetchChannelMessages();

    // Filter to kit requests
    const kitRequests = messages.filter(m => {
      const t = extractAllText(m);
      return t.includes('IVJN-') && (
        t.includes('Kit Request') ||
        t.includes('Requester') ||
        t.includes('Destination')
      );
    });

    // Fetch threads in parallel (limit to 15 to avoid timeout)
    const limited = kitRequests.slice(0, 15);
    const threadsData = await Promise.all(
      limited.map(msg => fetchThread(msg.ts))
    );

    // Filter to only messages where @marina-mpms was tagged
    const marinaRequests = limited.filter((msg, i) => {
      const allText = threadsData[i].map(r => extractAllText(r)).join('\n');
      return allText.includes(MARINA_GROUP) || allText.includes('marina-mpms');
    });

    // Collect all unique user IDs to resolve
    const userIds = marinaRequests
      .map(msg => extractRequesterId(extractAllText(msg)))
      .filter(Boolean);

    // Resolve all names in one batch
    const userMap = await buildUserMap(userIds);

    // Build results
    const results = marinaRequests.map((msg, idx) => {
      const i          = limited.indexOf(msg);
      const replies    = threadsData[i];
      const fullText   = extractAllText(msg);
      const userId     = extractRequesterId(fullText);
      const requester  = userId ? (userMap[userId] || userId) : 'Unknown';

      return {
        id:             extractTicketId(fullText) || msg.ts,
        requester,
        timestamp:      new Date(parseFloat(msg.ts) * 1000).toISOString(),
        priority:       parsePriority(fullText),
        warehouse:      parseLabel(fullText, 'Destination Warehouse') || '—',
        location:       parseLabel(fullText, 'Destination Location')  || '—',
        dateNeeded:     parseLabel(fullText, 'Date Needed')            || '—',
        status:         deriveStatus(replies),
        threadActivity: extractThreadNote(replies),
        threadUrl:      buildPermalink(msg.ts),
        replyCount:     Math.max(0, replies.length - 1),
      };
    });

    // Sort by priority then date
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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}