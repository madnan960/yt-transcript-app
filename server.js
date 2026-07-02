const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
const RAPID_KEY = process.env.RAPID_KEY || "RAPID_KEY_HERE";
const RAPID_HOST = "youtube-captions-transcript-subtitles-video-combiner.p.rapidapi.com";
const GROQ_KEY = process.env.GROQ_API_KEY || "GROQ_KEY_HERE";

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

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&apos;/g, "'");
}

function httpsRequest(options, body) {
  return new Promise(function(resolve, reject) {
    const req = https.request(options, function(res) {
      let data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on("error", reject);
    if (body) req.write(body);
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

async function fetchYouTubeTranscript(videoId, lang) {
  const language = (lang && lang !== "auto") ? lang : "en";
  const langs = [language, "en", "en-US"];
  for (let i = 0; i < langs.length; i++) {
    const options = {
      method: "GET",
      hostname: RAPID_HOST,
      path: "/download-webvtt/" + videoId + "?language=" + langs[i] + "&response_mode=default",
      headers: { "x-rapidapi-key": RAPID_KEY, "x-rapidapi-host": RAPID_HOST }
    };
    const res = await httpsRequest(options);
    if (res.status === 200 && res.body.includes("-->")) {
      const segments = parseVTT(res.body);
      if (segments.length > 0) return segments;
    }
  }
  const langOptions = {
    method: "GET",
    hostname: RAPID_HOST,
    path: "/get-available-languages/" + videoId,
    headers: { "x-rapidapi-key": RAPID_KEY, "x-rapidapi-host": RAPID_HOST }
  };
  const langRes = await httpsRequest(langOptions);
  if (langRes.status === 200) {
    try {
      const availLangs = JSON.parse(langRes.body);
      if (Array.isArray(availLangs) && availLangs.length > 0) {
        const firstLang = availLangs[0].code || availLangs[0].languageCode || availLangs[0];
        const retryOpts = {
          method: "GET",
          hostname: RAPID_HOST,
          path: "/download-webvtt/" + videoId + "?language=" + firstLang + "&response_mode=default",
          headers: { "x-rapidapi-key": RAPID_KEY, "x-rapidapi-host": RAPID_HOST }
        };
        const retryRes = await httpsRequest(retryOpts);
        if (retryRes.status === 200) {
          const segments = parseVTT(retryRes.body);
          if (segments.length > 0) return segments;
        }
      }
    } catch(e) {}
  }
  throw new Error("No captions found. Make sure the video has subtitles/captions enabled.");
}

async function fetchTikTokTranscript(url) {
  const options = {
    method: "GET",
    hostname: "tiktok-video-transcript.p.rapidapi.com",
    path: "/transcribe?url=" + encodeURIComponent(url) + "&language=en-US&timestamps=true",
    headers: {
      "x-rapidapi-key": RAPID_KEY,
      "x-rapidapi-host": "tiktok-video-transcript.p.rapidapi.com"
    }
  };
  const result = await httpsRequest(options);
  if (result.status !== 200) throw new Error("Could not fetch TikTok transcript.");
  const data = JSON.parse(result.body);
  if (!data.success || !data.text) throw new Error("No transcript found for this TikTok video.");
  const segments = [];
  if (data.words && Array.isArray(data.words) && data.words.length > 0) {
    const chunkSize = 10;
    for (let i = 0; i < data.words.length; i += chunkSize) {
      const chunk = data.words.slice(i, i + chunkSize);
      const text = chunk.map(function(w) { return w.text || w.word || ""; }).join(" ").trim();
      const offset = chunk[0].start !== undefined ? chunk[0].start : 0;
      if (text) segments.push({ text: text, offset: offset, time: formatTime(offset) });
    }
  }
  if (segments.length === 0) {
    const words = data.text.split(" ");
    for (let i = 0; i < words.length; i += 15) {
      segments.push({ text: words.slice(i, i + 15).join(" "), offset: 0, time: "00:00" });
    }
  }
  return { segments: segments, plain: data.text };
}

app.post("/api/transcript", async function(req, res) {
  const url = req.body && req.body.url;
  const lang = req.body && req.body.lang;
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Please enter a valid YouTube link or video ID." });
  try {
    const segments = await fetchYouTubeTranscript(videoId, lang);
    const plain = segments.map(function(s) { return s.text; }).join(" ");
    return res.json({ videoId: videoId, count: segments.length, segments: segments, plain: plain });
  } catch(err) {
    return res.status(404).json({ error: err.message || "Could not fetch transcript." });
  }
});

app.post("/api/tiktok", async function(req, res) {
  const url = req.body && req.body.url;
  if (!url || !url.includes("tiktok.com")) return res.status(400).json({ error: "Please enter a valid TikTok video link." });
  try {
    const data = await fetchTikTokTranscript(url);
    const videoId = (url.match(/video\/(\d+)/) || [])[1] || "tiktok";
    return res.json({ videoId: videoId, count: data.segments.length, segments: data.segments, plain: data.plain });
  } catch(err) {
    return res.status(500).json({ error: err.message || "TikTok transcript error." });
  }
});

app.post("/api/find-clips", async function(req, res) {
  const segments = req.body && req.body.segments;
  const duration = req.body && req.body.duration;
  if (!segments || segments.length === 0) return res.status(400).json({ error: "No transcript provided." });

  const durationMins = duration ? duration / 60 : 0;
  const clipCount = durationMins >= 30 ? "7-8" : durationMins >= 15 ? "4-5" : "3-4";

  const transcriptText = segments.map(function(s) {
    return "[" + s.time + "] " + s.text;
  }).join("\n").substring(0, 6000);

  const userPrompt = "You are a viral content expert. Analyze this video transcript and find the " + clipCount + " best clips that would go viral on YouTube Shorts or TikTok.\n\nRULES:\n- Each clip must be exactly 40-45 seconds long\n- Pick the most engaging, surprising, funny, or valuable moments\n- Clips must make sense on their own\n- Return ONLY valid JSON\n\nTRANSCRIPT:\n" + transcriptText + "\n\nReturn this JSON format:\n{\"clips\":[{\"clip_number\":1,\"start_time\":\"00:00\",\"end_time\":\"00:42\",\"title\":\"Viral title\",\"hook\":\"Opening line\",\"tags\":[\"tag1\",\"tag2\",\"tag3\",\"tag4\",\"tag5\",\"tag6\",\"tag7\",\"tag8\"],\"why_viral\":\"Why this works\"}]}";

  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    max_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: userPrompt }]
  });

  try {
    const options = {
      method: "POST",
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const result = await httpsRequest(options, body);
    const data = JSON.parse(result.body);

    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: "AI response empty." });
    }

    const clips = JSON.parse(data.choices[0].message.content);
    return res.json(clips);

  } catch(err) {
    return res.status(500).json({ error: "AI error: " + (err.message || "Unknown") });
  }
});

app.get("/api/health", function(req, res) { res.json({ status: "ok" }); });
app.get("/", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, function() { console.log("Server running on port " + PORT); });
