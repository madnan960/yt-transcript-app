const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = function(n) { return String(n).padStart(2, "0"); };
  return h ? (pad(h) + ":" + pad(m) + ":" + pad(s)) : (pad(m) + ":" + pad(s));
}

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

// Fetch transcript by scraping YouTube's timedtext API directly
async function fetchTranscriptDirect(videoId, lang) {
  const https = require("https");

  function httpsGet(url, headers) {
    return new Promise(function(resolve, reject) {
      const opts = { headers: headers || {} };
      https.get(url, opts, function(res) {
        let data = "";
        res.on("data", function(c) { data += c; });
        res.on("end", function() { resolve({ status: res.statusCode, body: data }); });
      }).on("error", reject);
    });
  }

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  // Get video page
  const pageRes = await httpsGet("https://www.youtube.com/watch?v=" + videoId, headers);
  if (pageRes.status !== 200) throw new Error("Video page not accessible (status " + pageRes.status + ")");

  const html = pageRes.body;

  // Extract captions data
  const captionsMatch = html.match(/"captions":\s*(\{"playerCaptionsTracklistRenderer":.+?\})\s*,\s*"videoDetails"/);
  if (!captionsMatch) {
    if (html.includes("VIDEO_UNAVAILABLE") || html.includes("videoUnavailable")) {
      throw new Error("This video is unavailable or private.");
    }
    throw new Error("No captions found. The video must have captions/subtitles enabled.");
  }

  let captionsData;
  try {
    captionsData = JSON.parse(captionsMatch[1]);
  } catch(e) {
    throw new Error("Could not parse captions data.");
  }

  const tracks = captionsData.playerCaptionsTracklistRenderer && captionsData.playerCaptionsTracklistRenderer.captionTracks;
  if (!tracks || tracks.length === 0) {
    throw new Error("No caption tracks available for this video.");
  }

  // Find requested language or use first track
  let track = tracks[0];
  if (lang && lang !== "auto") {
    const found = tracks.find(function(t) {
      return t.languageCode && t.languageCode.toLowerCase().startsWith(lang.toLowerCase());
    });
    if (found) track = found;
  }

  const captionUrl = track.baseUrl + "&fmt=json3";
  const captionRes = await httpsGet(captionUrl, headers);
  if (captionRes.status !== 200) throw new Error("Could not fetch caption file.");

  let captionJson;
  try {
    captionJson = JSON.parse(captionRes.body);
  } catch(e) {
    throw new Error("Could not parse caption file.");
  }

  const events = captionJson.events || [];
  const segments = [];

  events.forEach(function(event) {
    if (!event.segs) return;
    const text = event.segs.map(function(s) { return s.utf8 || ""; }).join("").replace(/\n/g, " ").trim();
    if (!text || text === " ") return;
    const offset = (event.tStartMs || 0) / 1000;
    segments.push({ text: text, offset: offset, time: formatTime(offset) });
  });

  if (segments.length === 0) throw new Error("No transcript segments found.");
  return segments;
}

app.post("/api/transcript", async function(req, res) {
  const url = req.body && req.body.url;
  const lang = req.body && req.body.lang;
  const videoId = extractVideoId(url);

  if (!videoId) {
    return res.status(400).json({ error: "Please enter a valid YouTube link or video ID." });
  }

  try {
    const segments = await fetchTranscriptDirect(videoId, lang);
    const plain = segments.map(function(s) { return s.text; }).join(" ");
    return res.json({ videoId: videoId, count: segments.length, segments: segments, plain: plain });
  } catch(err) {
    let msg = err.message || "Could not fetch transcript.";
    return res.status(404).json({ error: msg });
  }
});

app.post("/api/tiktok", async function(req, res) {
  return res.status(404).json({ error: "TikTok does not provide public caption access via API. Try using TikTok's built-in caption feature." });
});

app.get("/api/health", function(req, res) { res.json({ status: "ok" }); });
app.get("/", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, function() { console.log("Server running on port " + PORT); });
