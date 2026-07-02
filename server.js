const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");

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
    const opts = {
      headers: headers || {},
      timeout: 10000
    };
    https.get(url, opts, function(res) {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() { resolve({ status: res.statusCode, body: data }); });
    }).on("error", reject).on("timeout", function() { reject(new Error("Request timed out")); });
  });
}

async function fetchTranscript(videoId, lang) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Encoding": "identity",
    "Connection": "keep-alive",
  };

  const pageRes = await httpsGet("https://www.youtube.com/watch?v=" + videoId + "&hl=en", headers);
  
  if (pageRes.status !== 200) {
    throw new Error("Could not access YouTube video (status " + pageRes.status + ")");
  }

  const html = pageRes.body;

  // Try multiple regex patterns to find captions
  let captionTracks = null;

  // Pattern 1: standard
  const m1 = html.match(/"captionTracks":\s*(\[.*?\])\s*,\s*"audioTracks"/);
  if (m1) {
    try { captionTracks = JSON.parse(m1[1]); } catch(e) {}
  }

  // Pattern 2: alternative
  if (!captionTracks) {
    const m2 = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
    if (m2) {
      try { captionTracks = JSON.parse(m2[1]); } catch(e) {}
    }
  }

  // Pattern 3: playerCaptionsTracklistRenderer
  if (!captionTracks) {
    const m3 = html.match(/"playerCaptionsTracklistRenderer":\s*\{.*?"captionTracks":\s*(\[[\s\S]*?\])/);
    if (m3) {
      try { captionTracks = JSON.parse(m3[1]); } catch(e) {}
    }
  }

  if (!captionTracks || captionTracks.length === 0) {
    if (html.includes("VIDEO_UNAVAILABLE") || html.includes('"status":"ERROR"')) {
      throw new Error("This video is unavailable or private.");
    }
    if (html.includes("Sign in") && html.length < 50000) {
      throw new Error("YouTube is requiring sign-in for this video.");
    }
    throw new Error("No captions found. This video must have captions/subtitles enabled.");
  }

  // Select track by language
  let track = captionTracks[0];
  if (lang && lang !== "auto") {
    const found = captionTracks.find(function(t) {
      return t.languageCode && t.languageCode.toLowerCase().startsWith(lang.toLowerCase());
    });
    if (found) track = found;
  }

  if (!track || !track.baseUrl) {
    throw new Error("Caption track URL not found.");
  }

  // Fetch XML captions (more reliable than json3)
  const xmlUrl = track.baseUrl + "&fmt=srv3";
  const captionRes = await httpsGet(xmlUrl, headers);

  if (captionRes.status !== 200) {
    throw new Error("Could not download captions (status " + captionRes.status + ")");
  }

  const xml = captionRes.body;
  const segments = [];

  // Parse XML/ttml format
  const regex = /<p[^>]+t="(\d+)"[^>]*d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const startMs = parseInt(match[1]);
    const text = match[3]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, " ")
      .trim();
    if (text) {
      const offset = startMs / 1000;
      segments.push({ text: text, offset: offset, time: formatTime(offset) });
    }
  }

  // Fallback: try srv1 format (plain text)
  if (segments.length === 0) {
    const srv1Url = track.baseUrl + "&fmt=srv1";
    const srv1Res = await httpsGet(srv1Url, headers);
    const srv1 = srv1Res.body;
    const rx2 = /<text start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m2;
    while ((m2 = rx2.exec(srv1)) !== null) {
      const offset = parseFloat(m2[1]);
      const text = m2[2]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\n/g, " ").trim();
      if (text) {
        segments.push({ text: text, offset: offset, time: formatTime(offset) });
      }
    }
  }

  if (segments.length === 0) {
    throw new Error("Captions downloaded but could not be parsed. Please try another video.");
  }

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
    const segments = await fetchTranscript(videoId, lang);
    const plain = segments.map(function(s) { return s.text; }).join(" ");
    return res.json({ videoId: videoId, count: segments.length, segments: segments, plain: plain });
  } catch(err) {
    return res.status(404).json({ error: err.message || "Could not fetch transcript." });
  }
});

app.post("/api/tiktok", async function(req, res) {
  return res.status(404).json({ error: "TikTok does not provide public caption access via API." });
});

app.get("/api/health", function(req, res) { res.json({ status: "ok" }); });
app.get("/", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, function() { console.log("Server running on port " + PORT); });
