// api/requests.js
// Vercel serverless function — fetches @marina-mpms tagged requests from Slack
// Automatically called by the dashboard every 5 minutes

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

// ── Fetch last 200 messages from channel ──────────────────────────────────
async function fetchChannelMessages() {
  const msgs = [];
  let cursor;
  for (let i = 0; i < 2; i++) {
    const data = await slackGet('conversations.history', {
      channel: CHANNEL_ID,
      limit: 100,
      include_all_metadata: true,
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

// ── Parse helpers ──────────────────────────────────────────────────────────
function extractTicketId(text) {
  return text?.match(/IVJN-\d+/i)?.[0]?.toUpperCase() || null;
}

function parseRequester(text, blocks) {
  if (!text && !blocks) return 'Unknown';
  // Try blocks format first
  if (blocks) {
    for (const block of blocks) {
      if (block.type === 'section' && block.fields) {
        for (const field of block.fields) {
          if (field.text?.includes('Requester')) {
            const next = field.text.replace(/\*Requester:\*\s*/i, '').trim();
            const nameMatch = next.match(/<@[A-Z0-9]+\|([^>]+)>/) ||
                              next.match(/<mailto:[^|]+\|([^>]+)>/);
            if (nameMatch) return nameMatch[1];
            if (next.length > 0 && next.length < 60) return next;
          }
        }
      }
    }
  }
  // Try plain text format
  if (text) {
    const m1 = text.match(/\*Requester:\*\s*\n<@[A-Z0-9]+\|([^>]+)>/);
    if (m1) return m1[1];
    const m2 = text.match(/\*Requester:\*\s*\n<mailto:[^|]+\|([^>]+)>/);
    if (m2) return m2[1];
    const m3 = text.match(/Requester[:\s]+([^\n<*]{2,40})/i);
    if (m3) return m3[1].trim();
  }
  return 'Unknown';
}

function parseFieldFromBlocks(blocks, fieldName) {
  if (!blocks) return null;
  for (const block of blocks) {
    if (block.type === 'section' && block.fields) {
      for (const field of block.fields) {
        if (field.text?.includes(fieldName)) {
          const val = field.text
            .replace(new RegExp(`\\*?${fieldName}:\\*?\\s*`, 'i'), '')
            .replace(/<[^>]+>/g, '')
            .trim();
          if (val.length > 0 && val.length < 80) return val;
        }
      }
    }
    // Also check rich_text blocks
    if (block.type === 'rich_text') {
      const text = block.elements
        ?.flatMap(e => e.elements || [])
        ?.map(e => e.text || '')
        ?.join('') || '';
      if (text.includes(fieldName)) {
        const match = text.match(new RegExp(`${fieldName}[:\\s]+([^\\n]{2,60})`, 'i'));
        if (match) return match[1].trim();
      }
    }
  }
  return null;
}

function parseField(text, fieldName) {
  if (!text) return null;
  const patterns = [
    new RegExp(`\\*${fieldName}:\\*\\s*\\n([^\\n*<]+)`),
    new RegExp(`${fieldName}:\\s*\\n([^\\n*<]+)`),
    new RegExp(`\\*${fieldName}\\*:\\s*([^\\n*<]+)`),
    new RegExp(`${fieldName}[:\\s]+([^\\n<*]{2,60})`, 'i'),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

function parsePriority(text) {
  if (/line down/i.test(text) || /alert/i.test(text)) return 'linedown';
  if (/asap/i.test(text)) return 'asap';
  return 'asready';
}

function deriveStatus(replies) {
  const text = replies.map(r => r.text || '').join('\n');
  if (/staged|complete|courier|pick.?up rack|outbound rack/i.test(text)) return 'done';
  if (/:approved:|approved|✅/i.test(text)) return 'approved';
  if (/cancel/i.test(text)) return 'cancelled';
  return 'pending';
}

function extractThreadNote(replies) {
  const meaningful = replies.slice(1).find(r =>
    r.user && r.text?.length > 20
  );
  return meaningful?.text
    ?.replace(/<[^>]+>/g, '')
    ?.replace(/\s+/g, ' ')
    ?.trim()
    ?.slice(0, 120) || null;
}

function buildPermalink(ts) {
  const tsSafe = ts.replace('.', '');
  return `https://jobyaviation.slack.com/archives/${CHANNEL_ID}/p${tsSafe}`;
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (!SLACK_TOKEN) {
    return res.status(500).json({ error: 'SLACK_BOT_TOKEN not set in environment variables' });
  }

  try {
    // Step 1 — test if token works by fetching channel info
    const channelInfo = await slackGet('conversations.info', { channel: CHANNEL_ID });
    if (!channelInfo.ok) {
      return res.status(200).json({
        error: 'Cannot access channel',
        slack_error: channelInfo.error,
        fix: channelInfo.error === 'not_in_channel'
          ? 'Bot needs to be invited to #part-requests-marina. Type /invite @Marina Dashboard in that channel.'
          : channelInfo.error === 'invalid_auth'
          ? 'SLACK_BOT_TOKEN is invalid. Check your token in Vercel environment variables.'
          : channelInfo.error,
      });
    }

    // Step 2 — fetch messages
    const messages = await fetchChannelMessages();

    // Step 3 — debug: return raw count before filtering
    const kitRequests = messages.filter(m =>
      m.text?.includes('IVJN-') || m.text?.includes('Kit Request')
    );

    if (kitRequests.length === 0) {
      return res.status(200).json({
        debug: true,
        message: 'Connected to Slack but no kit requests found in last 200 messages',
        total_messages_fetched: messages.length,
        channel: channelInfo.channel?.name,
        requests: [],
        fetchedAt: new Date().toISOString(),
        total: 0,
      });
    }

    // Step 4 — fetch threads and filter by @marina-mpms
    const results = await Promise.all(
      kitRequests.map(async (msg) => {
        const replies = await fetchThread(msg.ts);
        const allText = replies.map(r => r.text || '').join('\n');
        if (!allText.includes(MARINA_GROUP)) return null;

        return {
          id:             extractTicketId(msg.text) || msg.ts,
          requester:      parseRequester(msg.text, msg.blocks),
          timestamp:      new Date(parseFloat(msg.ts) * 1000).toISOString(),
          priority:       parsePriority(msg.text),
          warehouse:      parseFieldFromBlocks(msg.blocks, 'Destination Warehouse') || parseField(msg.text, 'Destination Warehouse') || '—',
          location:       parseFieldFromBlocks(msg.blocks, 'Destination Location')  || parseField(msg.text, 'Destination Location')  || '—',
          dateNeeded:     parseFieldFromBlocks(msg.blocks, 'Date Needed')            || parseField(msg.text, 'Date Needed')            || '—',
          status:         deriveStatus(replies),
          threadActivity: extractThreadNote(replies),
          threadUrl:      buildPermalink(msg.ts),
          replyCount:     replies.length - 1,
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