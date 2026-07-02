const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const RAPID_API_KEY = process.env.RAPID_API_KEY || "2b8d22e53emsh91b83d42b01f4dap1e3b20jsn84a2034a2ac8";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = function(n) { return String(n).padStart(2, "0"); };
  return h ? (pad(h)+":"+pad(m)+":"+pad(s)) : (pad(m)+":"+pad(s));
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

function httpsGet(url, headers) {
  return new Promise(function(resolve, reject) {
    https.get(url, { headers: headers || {} }, function(res) {
      let data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() { resolve({ status: res.statusCode, body: data }); });
    }).on("error", reject);
  });
}

// Parse VTT subtitle format
function parseVTT(vtt) {
  const segments = [];
  const lines = vtt.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    // Time line: 00:00:01.000 --> 00:00:04.000
    const timeMatch = line.match(/(\d{2}:\d{2}:\d{2}[\.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[\.,]\d{3})/);
    if (timeMatch) {
      const startStr = timeMatch[1].replace(",", ".");
      const parts = startStr.split(":");
      const seconds = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
      i++;
      let text = "";
      while (i < lines.length && lines[i].trim() !== "") {
        text += (text ? " " : "") + lines[i].trim().replace(/<[^>]+>/g, "");
        i++;
      }
      text = text.trim();
      if (text && !text.startsWith("WEBVTT") && !text.startsWith("NOTE")) {
        segments.push({ text: text, offset: seconds, time: formatTime(seconds) });
      }
    }
    i++;
  }
  return segments;
}

async function fetchViaRapidAPI(videoId, lang) {
  const language = (lang && lang !== "auto") ? lang : "en";
  const url = "https://youtube-captions-transcript-subtitles-video-combiner.p.rapidapi.com/download-webvtt/" + videoId + "XI?language=" + language + "&response_mode=default";
  
  const headers = {
    "x-rapidapi-key": RAPID_API_KEY,
    "x-rapidapi-host": "youtube-captions-transcript-subtitles-video-combiner.p.rapidapi.com",
    "Content-Type": "application/json"
  };

  const res = await httpsGet(url, headers);
  
  if (res.status === 404) {
    // Try without language (auto)
    const url2 = "https://youtube-captions-transcript-subtitles-video-combiner.p.rapidapi.com/download-webvtt/" + videoId + "XI?language=en&response_mode=default";
    const res2 = await httpsGet(url2, headers);
    if (res2.status !== 200) throw new Error("No captions found for this video.");
    return parseVTT(res2.body);
  }
  
  if (res.status !== 200) {
    throw new Error("API error (status " + res.status + "): " + res.body.substring(0, 100));
  }

  const segments = parseVTT(res.body);
  if (segments.length === 0) throw new Error("No caption content found in the response.");
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
    const segments = await fetchViaRapidAPI(videoId, lang);
    const plain = segments.map(function(s) { return s.text; }).join(" ");
    return res.json({ videoId: videoId, count: segments.length, segments: segments, plain: plain });
  } catch(err) {
    return res.status(404).json({ error: err.message || "Could not fetch transcript." });
  }
});

app.post("/api/tiktok", async function(req, res) {
  return res.status(404).json({ error: "TikTok captions are not available via public API." });
});

app.get("/api/health", function(req, res) { res.json({ status: "ok" }); });
app.get("/", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, function() { console.log("Server running on port " + PORT); });
