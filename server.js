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
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

async function fetchWithYoutubei(videoId, lang) {
  const yt = await getInnertube();
  const info = await yt.getInfo(videoId);
  const transcriptInfo = await info.getTranscript();
  if (!transcriptInfo) throw new Error("Transcript not available");
  if (lang && lang !== "auto") {
    try {
      const langResult = await transcriptInfo.selectLanguage(lang);
      if (langResult) {
        return langResult.transcript.content.body.initial_segments.map((s) => {
          const text = s.snippet && s.snippet.runs ? s.snippet.runs.map((r) => r.text).join("") : "";
          const offset = (s.start_ms || 0) / 1000;
          return { text: text.replace(/\s+/g, " ").trim(), offset, time: formatTime(offset) };
        }).filter((s) => s.text);
      }
    } catch (e) {}
  }
  return transcriptInfo.transcript.content.body.initial_segments.map((s) => {
    const text = s.snippet && s.snippet.runs ? s.snippet.runs.map((r) => r.text).join("") : "";
    const offset = (s.start_ms || 0) / 1000;
    return { text: text.replace(/\s+/g, " ").trim(), offset, time: formatTime(offset) };
  }).filter((s) => s.text);
}

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

app.post("/api/transcript", async (req, res) => {
  const url = req.body && req.body.url;
  const lang = req.body && req.body.lang;
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: "Please enter a valid YouTube link or video ID." });
  }
  let segments = null;
  let lastErr = null;
  for (const fetcher of [fetchWithYoutubei, fetchWithLegacy]) {
    try {
      segments = await fetcher(videoId, lang);
      if (segments && segments.length > 0) break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!segments || segments.length === 0) {
    let msg = (lastErr && lastErr.message) || "Could not fetch transcript.";
    if (/disabled/i.test(msg)) msg = "Captions are disabled on this video.";
    else if (/no longer available|unavailable/i.test(msg)) msg = "This video is unavailable or private.";
    else if (/No transcripts|not available/i.test(msg)) msg = "No transcript found. The video must have captions enabled.";
    return res.status(404).json({ error: msg });
  }
  const plain = segments.map((s) => s.text).join(" ");
  res.json({ videoId, count: segments.length, segments, plain });
});

app.post("/api/tiktok", async (req, res) => {
  const url = req.body && req.body.url;
  if (!url || !url.includes("tiktok.com")) {
    return res.status(400).json({ error: "Please enter a valid TikTok video link." });
  }
  try {
    const oembedUrl = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url);
    const data = await new Promise(function(resolve, reject) {
      https.get(oembedUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, function(r) {
        let d = "";
        r.on("data", function(c) { d += c; });
        r.on("end", function() { resolve(JSON.parse(d)); });
      }).on("error", reject);
    });
    return res.status(404).json({
      error: "Video found: " + data.title + " by @" + data.author_name + ". TikTok does not allow public caption access."
    });
  } catch (e) {
    return res.status(500).json({ error: "Could not reach TikTok. Make sure the link is valid and public." });
  }
});

app.get("/api/health", function(req, res) {
  res.json({ status: "ok" });
});

app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
  getInnertube().catch(function() {});
});
