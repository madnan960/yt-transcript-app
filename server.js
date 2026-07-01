/**
 * YouTube Transcript Tool — Backend (v2 with youtubei.js)
 * Run:  node server.js
 * Open: http://localhost:3000
 */

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Cache the Innertube instance (expensive to create each time)
let innertubeInstance = null;
async function getInnertube() {
  if (!innertubeInstance) {
    const { Innertube } = await import("youtubei.js");
    innertubeInstance = await Innertube.create({ retrieve_player: false });
  }
  return innertubeInstance;
}

// --- Helper: extract video ID from any YouTube URL ---
function extractVideoId(input) {
  if (!input) return null;
  input = input.trim();
  const patterns = [
    /(?:v=|\/)([0-9A-Za-z_-]{11}).*/,
    /(?:youtu\.be\/)([0-9A-Za-z_-]{11})/,
    /(?:shorts\/)([0-9A-Za-z_-]{11})/,
    /(?:embed\/)([0-9A-Za-z_-]{11})/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  if (/^[0-9A-Za-z_-]{11}$/.test(input)) return input;
  return null;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// --- Primary: youtubei.js ---
async function fetchWithYoutubei(videoId, lang) {
  const yt = await getInnertube();
  const info = await yt.getInfo(videoId);

  const transcriptInfo = await info.getTranscript();
  if (!transcriptInfo) throw new Error("Transcript not available");

  // Try to switch language if requested
  if (lang && lang !== "auto") {
    try {
      const langResult = await transcriptInfo.selectLanguage(lang);
      if (langResult) {
        const segments = langResult.transcript.content.body.initial_segments.map((s) => {
          const text = s.snippet?.runs?.map((r) => r.text).join("") || "";
          const offset = (s.start_ms || 0) / 1000;
          return { text: text.replace(/\s+/g, " ").trim(), offset, time: formatTime(offset) };
        }).filter((s) => s.text);
        return segments;
      }
    } catch (_) {
      // Fall through to default language
    }
  }

  const segments = transcriptInfo.transcript.content.body.initial_segments.map((s) => {
    const text = s.snippet?.runs?.map((r) => r.text).join("") || "";
    const offset = (s.start_ms || 0) / 1000;
    return { text: text.replace(/\s+/g, " ").trim(), offset, time: formatTime(offset) };
  }).filter((s) => s.text);

  return segments;
}

// --- Fallback: youtube-transcript package ---
async function fetchWithLegacy(videoId, lang) {
  const { YoutubeTranscript } = require("youtube-transcript");
  const options = lang && lang !== "auto" ? { lang } : {};
  const data = await YoutubeTranscript.fetchTranscript(videoId, options);
  return data.map((d) => ({
    text: d.text.replace(/\s+/g, " ").trim(),
    offset: d.offset / 1000,
    time: formatTime(d.offset / 1000),
  }));
}

// --- API: transcript ---
app.post("/api/transcript", async (req, res) => {
  const { url, lang } = req.body || {};
  const videoId = extractVideoId(url);

  if (!videoId) {
    return res.status(400).json({ error: "Valid YouTube link ya video ID dein." });
  }

  let segments = null;
  let lastErr = null;

  // Try youtubei.js first, fallback to legacy
  for (const fetcher of [fetchWithYoutubei, fetchWithLegacy]) {
    try {
      segments = await fetcher(videoId, lang);
      if (segments && segments.length > 0) break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!segments || segments.length === 0) {
    let msg = lastErr?.message || "Transcript fetch nahi ho saka.";
    if (/disabled/i.test(msg)) msg = "Is video par captions/transcript disabled hai.";
    else if (/no longer available|unavailable/i.test(msg)) msg = "Video available nahi hai ya private hai.";
    else if (/No transcripts|not available/i.test(msg)) msg = "Is video ka koi transcript nahi mila. Captions enabled hone chahiye.";
    else if (/too many/i.test(msg)) msg = "YouTube ne rate limit kar diya. Thodi der baad try karein.";
    return res.status(404).json({ error: msg });
  }

  const plain = segments.map((s) => s.text).join(" ");
  res.json({ videoId, count: segments.length, segments, plain });
});

// --- API: health check ---
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Transcript tool chal raha hai:  http://localhost:${PORT}`);
  // Pre-warm youtubei.js
  getInnertube().then(() => console.log("✅ YouTube client ready")).catch(() => {});
});
