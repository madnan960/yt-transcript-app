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

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
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
        const t = decodeEntities(lines[i].trim().replace(/<[^>]+>/g, "").trim());
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
  const url = req.body && req.body.url;
  if (!url || !url.includes("tiktok.com")) {
    return res.status(400).json({ error: "Please enter a valid TikTok video link." });
  }

  try {
    const apiUrl = "https://tiktok-video-transcript.p.rapidapi.com/transcribe?url=" + encodeURIComponent(url) + "&language=en-US&timestamps=true";
    const options = {
      method: "GET",
      hostname: "tiktok-video-transcript.p.rapidapi.com",
      path: "/transcribe?url=" + encodeURIComponent(url) + "&language=en-US&timestamps=true",
      headers: {
        "x-rapidapi-key": RAPID_KEY,
        "x-rapidapi-host": "tiktok-video-transcript.p.rapidapi.com",
        "Content-Type": "application/json"
      }
    };

    const result = await httpsGet(options);
    
    if (result.status !== 200) {
      return res.status(404).json({ error: "Could not fetch TikTok transcript (status " + result.status + ")." });
    }

    let data;
    try { data = JSON.parse(result.body); } catch(e) {
      return res.status(500).json({ error: "Could not parse TikTok response." });
    }

    if (!data.success || !data.text) {
      return res.status(404).json({ error: "No transcript found for this TikTok video." });
    }

    // Parse timestamps - group words into sentence chunks
    const segments = [];
    if (data.words && Array.isArray(data.words) && data.words.length > 0) {
      // Group every ~10 words into a segment
      const chunkSize = 10;
      let i = 0;
      while (i < data.words.length) {
        const chunk = data.words.slice(i, i + chunkSize);
        const text = chunk.map(function(w) { return w.text || w.word || ""; }).join(" ").trim();
        const offset = chunk[0].start !== undefined ? chunk[0].start : (chunk[0].startTime || 0);
        if (text) {
          segments.push({ text: text, offset: offset, time: formatTime(offset) });
        }
        i += chunkSize;
      }
    }

    if (segments.length === 0) {
      // Split plain text into chunks of ~100 chars
      const words = data.text.split(" ");
      const chunkSize = 15;
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(" ");
        segments.push({ text: chunk, offset: 0, time: "00:00" });
      }
      if (segments.length === 0) {
        segments.push({ text: data.text, offset: 0, time: "00:00" });
      }
    }

    const plain = data.text;
    const videoId = url.match(/video\/(\d+)/);
    return res.json({ 
      videoId: videoId ? videoId[1] : "tiktok", 
      count: segments.length, 
      segments: segments, 
      plain: plain 
    });

  } catch(err) {
    return res.status(500).json({ error: "TikTok transcript error: " + (err.message || "Unknown error") });
  }
});

app.get("/api/health", function(req, res) { res.json({ status: "ok" }); });
app.get("/", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, function() { console.log("Server running on port " + PORT); });





// AI Clip Finder endpoint
app.post("/api/find-clips", async function(req, res) {
  const segments = req.body && req.body.segments;
  const plain = req.body && req.body.plain;
  const duration = req.body && req.body.duration;

  if (!segments || !plain) {
    return res.status(400).json({ error: "No transcript provided." });
  }

  // Determine clip count based on video duration (in minutes)
  const durationMins = duration ? duration / 60 : 0;
  const clipCount = durationMins >= 30 ? "7-8" : durationMins >= 15 ? "4-5" : "3-4";

  // Build transcript with timestamps for Claude
  const transcriptWithTime = segments.map(function(s) {
    return "[" + s.time + "] " + s.text;
  }).join("\n");

  const prompt = `You are a viral content expert. Analyze this video transcript and find the ${clipCount} best clips that would go viral on YouTube Shorts or TikTok.

RULES:
- Each clip must be exactly 40-45 seconds long (find start and end timestamps)
- Pick the most engaging, surprising, funny, or valuable moments
- Clips must make sense on their own without context
- Return ONLY valid JSON, no other text

TRANSCRIPT:
${transcriptWithTime.substring(0, 8000)}

Return this exact JSON format:
{
  "clips": [
    {
      "clip_number": 1,
      "start_time": "00:00",
      "end_time": "00:42",
      "start_seconds": 0,
      "end_seconds": 42,
      "title": "Catchy viral title here",
      "hook": "First sentence that grabs attention",
      "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
      "why_viral": "One sentence why this clip will go viral"
    }
  ]
}`;

  try {
    const https = require("https");
    const body = JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    });

    const data = await new Promise(function(resolve, reject) {
      const reqOptions = {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY || "",
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body)
        }
      };

      const r = https.request(reqOptions, function(response) {
        let d = "";
        response.on("data", function(c) { d += c; });
        response.on("end", function() { resolve(JSON.parse(d)); });
      });
      r.on("error", reject);
      r.write(body);
      r.end();
    });

    if (!data.content || !data.content[0]) {
      return res.status(500).json({ error: "AI response empty." });
    }

    const text = data.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: "Could not parse AI response." });

    const clips = JSON.parse(jsonMatch[0]);
    return res.json(clips);

  } catch(err) {
    return res.status(500).json({ error: "AI error: " + (err.message || "Unknown") });
  }
});
