const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let innertubeInstance = null;

async function getInnertube() {
  if (!innertubeInstance) {
    const { Innertube } = await import("youtubei.js");
    innertubeInstance = await Innertube.create({ retrieve_player: false });
  }
  return innertubeInstance;
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

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = function(n) { return String(n).padStart(2, "0"); };
  return h ? (pad(h) + ":" + pad(m) + ":" + pad(s)) : (pad(m) + ":" + pad(s));
}

async function fetchWithLegacy(videoId, lang) {
  const { YoutubeTranscript } = require("youtube-transcript");
  const options = lang && lang !== "auto" ? { lang: lang } : {};
  const data = await YoutubeTranscript.fetchTranscript(videoId, options);
  if (!data || !Array.isArray(data)) throw new Error("No transcript data");
  return data.map(function(d) {
    return {
      text: d.text.replace(/\s+/g, " ").trim(),
      offset: d.offset / 1000,
      time: formatTime(d.offset / 1000),
    };
  });
}

async function fetchWithYoutubei(videoId, lang) {
  const yt = await getInnertube();
  const info = await yt.getInfo(videoId);
  const transcriptInfo = await info.getTranscript();
  if (!transcriptInfo) throw new Error("Transcript not available");
  var body = transcriptInfo.transcript &&
             transcriptInfo.transcript.content &&
             transcriptInfo.transcript.content.body;
  if (!body || !body.initial_segments) throw new Error("No segments found");
  return body.initial_segments.map(function(s) {
    var text = "";
    if (s.snippet && s.snippet.runs && Array.isArray(s.snippet.runs)) {
      text = s.snippet.runs.map(function(r) { return r.text || ""; }).join("");
    }
    var offset = (s.start_ms || 0) / 1000;
    return { text: text.replace(/\s+/g, " ").trim(), offset: offset, time: formatTime(offset) };
  }).filter(function(s) { return s.text.length > 0; });
}

app.post("/api/transcript", async function(req, res) {
  var url = req.body && req.body.url;
  var lang = req.body && req.body.lang;
  var videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: "Please enter a valid YouTube link or video ID." });
  }
  var segments = null;
  var lastErr = null;
  try {
    segments = await fetchWithLegacy(videoId, lang);
  } catch (err) {
    lastErr = err;
  }
  if (!segments || segments.length === 0) {
    try {
      segments = await fetchWithYoutubei(videoId, lang);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!segments || segments.length === 0) {
    var msg = (lastErr && lastErr.message) || "Could not fetch transcript.";
    if (/disabled/i.test(msg)) msg = "Captions are disabled on this video.";
    else if (/no longer available|unavailable/i.test(msg)) msg = "This video is unavailable or private.";
    else if (/No transcripts|not available/i.test(msg)) msg = "No transcript found. The video must have captions enabled.";
    return res.status(404).json({ error: msg });
  }
  var plain = segments.map(function(s) { return s.text; }).join(" ");
  res.json({ videoId: videoId, count: segments.length, segments: segments, plain: plain });
});

app.post("/api/tiktok", async function(req, res) {
  var url = req.body && req.body.url;
  if (!url || !url.includes("tiktok.com")) {
    return res.status(400).json({ error: "Please enter a valid TikTok video link." });
  }
  try {
    var oembedUrl = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url);
    var data = await new Promise(function(resolve, reject) {
      https.get(oembedUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, function(r) {
        var d = "";
        r.on("data", function(c) { d += c; });
        r.on("end", function() {
          try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
        });
      }).on("error", reject);
    });
    return res.status(404).json({
      error: "TikTok video: " + data.title + " by @" + data.author_name + ". TikTok does not provide public caption access."
    });
  } catch (e) {
    return res.status(500).json({ error: "Could not reach TikTok. Make sure the link is valid and public." });
  }
});

app.get("/api/health", function(req, res) { res.json({ status: "ok" }); });
app.get("/", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, function() { console.log("Server running on port " + PORT); });
