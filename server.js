const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const RAPID_KEY = "2b8d22e53emsh91b83d42b01f4dap1e3b20jsn84a2034a2ac8";
const RAPID_HOST = "youtube-captions-transcript-subtitles-video-combiner.p.rapidapi.com";

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

function httpsGet(options) {
  return new Promise(function(resolve, reject) {
    const req = https.request(options, function(res) {
      let data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on("error", reject);
    req.end();
  });
}

function parseVTT(vtt) {
  const segments = [];
  const lines = vtt.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const timeMatch = line.match(/(\d{2}:\d{2}:\d{2}[\.,]\d{3})\s*-->\s*/);
    if (timeMatch) {
      const startStr = timeMatch[1].replace(",", ".");
      const parts = startStr.split(":");
      const seconds = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
      i++;
      let text = "";
      while (i < lines.length && lines[i].trim() !== "") {
        const t = lines[i].trim().replace(/<[^>]+>/g, "").trim();
        if (t) text += (text ? " " : "") + t;
        i++;
      }
      if (text && text.length > 0) {
        segments.push({ text: text, offset: seconds, time: formatTime(seconds) });
      }
    }
    i++;
  }
  return segments;
}

async function fetchTranscript(videoId, lang) {
  const language = (lang && lang !== "auto") ? lang : "en";
  
  // Try different language options
  const langs = [language, "en", "en-US"];
  
  for (let i = 0; i < langs.length; i++) {
    const l = langs[i];
    const options = {
      method: "GET",
      hostname: RAPID_HOST,
      path: "/download-webvtt/" + videoId + "?language=" + l + "&response_mode=default",
      headers: {
        "x-rapidapi-key": RAPID_KEY,
        "x-rapidapi-host": RAPID_HOST,
        "Content-Type": "application/json"
      }
    };
    
    const res = await httpsGet(options);
    
    if (res.status === 200 && res.body.includes("-->")) {
      const segments = parseVTT(res.body);
      if (segments.length > 0) return segments;
    }
  }
  
  // Try get-available-languages endpoint to see what's available
  const langOptions = {
    method: "GET",
    hostname: RAPID_HOST,
    path: "/get-available-languages/" + videoId,
    headers: {
      "x-rapidapi-key": RAPID_KEY,
      "x-rapidapi-host": RAPID_HOST,
      "Content-Type": "application/json"
    }
  };
  
  const langRes = await httpsGet(langOptions);
  
  if (langRes.status === 200) {
    let availLangs;
    try { availLangs = JSON.parse(langRes.body); } catch(e) { availLangs = null; }
    
    if (availLangs && Array.isArray(availLangs) && availLangs.length > 0) {
      // Try first available language
      const firstLang = availLangs[0].code || availLangs[0].languageCode || availLangs[0];
      const retryOptions = {
        method: "GET",
        hostname: RAPID_HOST,
        path: "/download-webvtt/" + videoId + "?language=" + firstLang + "&response_mode=default",
        headers: {
          "x-rapidapi-key": RAPID_KEY,
          "x-rapidapi-host": RAPID_HOST,
          "Content-Type": "application/json"
        }
      };
      const retryRes = await httpsGet(retryOptions);
      if (retryRes.status === 200) {
        const segments = parseVTT(retryRes.body);
        if (segments.length > 0) return segments;
      }
    }
    throw new Error("No captions available. Languages response: " + langRes.body.substring(0, 100));
  }
  
  throw new Error("No captions found for this video. Make sure the video has subtitles/captions enabled.");
}

app.post("/api/transcript", async function(req, res) {
  const url = req.body && req.body.url;
  const lang = req.body && req.body.lang;
  const videoId = extractVideoId(url);

  if (!videoId) return res.status(400).json({ error: "Please enter a valid YouTube link or video ID." });

  try {
    const segments = await fetchTranscript(videoId, lang);
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
