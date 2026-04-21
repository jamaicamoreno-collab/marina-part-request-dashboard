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

// ── Extract all text from a Slack message (blocks + text) ─────────────────
function extractAllText(msg) {
  const parts = [];

  // Add plain text field
  if (msg.text) parts.push(msg.text);

  // Walk all blocks and extract text recursively
  function walkBlocks(blocks) {
    if (!blocks) return;
    for (const block of blocks) {
      if (block.text?.text) parts.push(block.text.text);
      if (block.fields) {
        for (const f of block.fields) {
          if (f.text) parts.push(f.text);
        }
      }
      if (block.elements) walkBlocks(block.elements);
      if (block.blocks)   walkBlocks(block.blocks);
    }
  }
  walkBlocks(msg.blocks);
  walkBlocks(msg.attachments?.flatMap(a => a.blocks || []));

  return parts.join('\n');
}

// ── User name cache ────────────────────────────────────────────────────────
const userCache = {};
async function resolveUserId(userId) {
  if (!userId) return 'Unknown';
  if (userCache[userId]) return userCache[userId];
  try {
    const data = await slackGet('users.info', { user: userId });
    if (data.ok && data.user) {
      const name =
        data.user.profile?.display_name_normalized ||
        data.user.profile?.display_name ||
        data.user.profile?.real_name_normalized ||
        data.user.profile?.real_name ||
        data.user.real_name ||
        data.user.name ||
        userId;
      userCache[userId] = name;
      return name;
    }
  } catch (e) {
    // fall through
  }
  return userId;
}

// ── Parse helpers ──────────────────────────────────────────────────────────
function extractTicketId(text) {
  return text?.match(/IVJN-\d+/i)?.[0]?.toUpperCase() || null;
}

function extractRequesterId(text) {
  if (!text) return null;
  // Match *Requester:*\n<@USERID> or *Requester:*\n<@USERID|name>
  const m = text.match(/\*Requester:\*\s*[\n\r]+<@([A-Z0-9]+)(?:\|[^>]*)?>/);
  if (m) return m[1];
  // Also try mailto format to extract email as fallback
  const m2 = text.match(/\*Requester:\*\s*[\n\r]+<mailto:([^|>]+)/);
  if (m2) return m2[1]; // returns email
  return null;
}

// Extract value after a label like "*Requester:*\n" or "Requester: "
function parseLabel(text, label) {
  if (!text) return null;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    // *Label:*\nValue  (newline after colon)
    new RegExp(`\\*?${escaped}:?\\*?\\s*\\n([^\\n*]{1,80})`),
    // *Label:* Value  (space after colon)
    new RegExp(`\\*?${escaped}:?\\*?\\s+([^\\n*<]{1,80})`),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      // Strip Slack mention syntax like <@U123|name> → name
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
  // Find the first meaningful human reply (not the bot approval request)
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

    const messages = await fetchChannelMessages();

    // Filter to kit requests containing an IVJN ticket ID
    const kitRequests = messages.filter(m => {
      const t = extractAllText(m);
      return t.includes('IVJN-') && (
        t.includes('Kit Request') ||
        t.includes('Requester') ||
        t.includes('Destination')
      );
    });

    // For each fetch thread and check for @marina-mpms tag
    const results = await Promise.all(
      kitRequests.map(async (msg) => {
        const replies  = await fetchThread(msg.ts);
        const allText  = replies.map(r => extractAllText(r)).join('\n');

        // Only include if @marina-mpms was tagged somewhere in thread
        if (!allText.includes(MARINA_GROUP) && !allText.includes('marina-mpms')) return null;

        const fullText   = extractAllText(msg);
        const requesterId = extractRequesterId(fullText);
        const requester  = requesterId
          ? await resolveUserId(requesterId)
          : 'Unknown';
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
      })
    );

    const filtered = results.filter(Boolean);
    const order = { linedown: 0, asap: 1, asready: 2 };
    filtered.sort((a, b) =>
      (order[a.priority] - order[b.priority]) ||
      (new Date(b.timestamp) - new Date(a.timestamp))
    );

    res.status(200).json({
      requests:  filtered,
      fetchedAt: new Date().toISOString(),
      total:     filtered.length,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}