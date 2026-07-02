const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = process.env.PORT || 3000;
const RAPID_KEY = process.env.RAPID_KEY || "RAPID_KEY_HERE";
const RAPID_HOST = "youtube-captions-transcript-subtitles-video-combiner.p.rapidapi.com";
const GROQ_KEY = process.env.GROQ_API_KEY || "GROQ_KEY_HERE";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Fix CSP to allow inline scripts
app.use(function(req, res, next) {
  res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  next();
});

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

// Video info & download links endpoint (YT Downloader - yt-downloader1)
app.post("/api/video-info", async function(req, res) {
  var url = req.body && req.body.url;
  var platform = req.body && req.body.platform;
  if (!url) return res.status(400).json({ error: "Please provide a video URL." });

  try {
    var videoId = extractVideoId(url);

    if (platform === "tt" || (!videoId && url.includes("tiktok.com"))) {
      return res.json({
        title: "TikTok Video", thumbnail: "", channel: "TikTok",
        formats: [{ quality: "HD Download", ext: "mp4", url: "https://snaptik.app/?url=" + encodeURIComponent(url), size: "" }]
      });
    }

    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL." });

    var fullUrl = "https://www.youtube.com/watch?v=" + videoId;
    var opts = {
      method: "GET",
      hostname: "yt-downloader1.p.rapidapi.com",
      path: "/api?url=" + encodeURIComponent(fullUrl) + "&key=" + RAPID_KEY,
      headers: {
        "x-rapidapi-key": RAPID_KEY,
        "x-rapidapi-host": "yt-downloader1.p.rapidapi.com"
      }
    };

    var apiRes = await httpsRequest(opts);

    if (apiRes.status === 200) {
      var data = JSON.parse(apiRes.body);

      if (data && Array.isArray(data.medias) && data.medias.length > 0) {
        // Group: progressive video (with sound) first, then video-only, then audio
        var vidsProg = [], vidsOnly = [], audios = [];
        data.medias.forEach(function(m) {
          var q = String(m.quality || m.label || "");
          if (/kbps/i.test(q) || (!m.videoAvailable && m.audioAvailable)) audios.push(m);
          else if (m.requiresMerge) vidsOnly.push(m);
          else vidsProg.push(m);
        });

        function mkFormat(m, suffix) {
          var q = m.quality || m.label || "Video";
          var extStr = (m.extension || "mp4") + (m.formattedSize ? " \u00b7 " + m.formattedSize : "");
          return { quality: q + (suffix || ""), ext: extStr, url: m.url, size: m.formattedSize || "" };
        }

        var safeTitle = String(data.title || "video").replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "video";

        function mergeUrl(m) {
          return "/api/merge?v=" + encodeURIComponent(m.url) + "&a=" + encodeURIComponent(m.audioUrl) + "&title=" + encodeURIComponent(safeTitle);
        }

        var formats = []
          .concat(vidsProg.map(function(m) { return mkFormat(m, ""); }))
          .concat(vidsOnly.map(function(m) {
            if (m.audioUrl) {
              var f = mkFormat(m, "");
              f.url = mergeUrl(m);
              return f;
            }
            return mkFormat(m, " (no audio)");
          }))
          .concat(audios.map(function(m) { return mkFormat({ quality: "Audio (" + (m.quality || "") + ")", extension: m.extension, formattedSize: m.formattedSize, url: m.url }, ""); }));

        return res.json({
          title: data.title || "YouTube Video",
          thumbnail: (typeof data.thumbnail === "string" && data.thumbnail) ? data.thumbnail : ("https://img.youtube.com/vi/" + videoId + "/mqdefault.jpg"),
          channel: data.author || "YouTube",
          duration: data.duration || "",
          formats: formats
        });
      }
      return res.status(500).json({ error: "No download links found for this video." });
    }

    var msg = "Could not fetch download links. Status: " + apiRes.status;
    try {
      var e = JSON.parse(apiRes.body);
      if (e && (e.message || e.error)) msg = String(e.message || e.error);
    } catch(_) {}
    return res.status(500).json({ error: msg });

  } catch(err) {
    return res.status(500).json({ error: "Error: " + (err.message || "Unknown") });
  }
});

// Merge video + audio streams into a single mp4 via ffmpeg (streaming)
app.get("/api/merge", function(req, res) {
  var v = req.query.v, a = req.query.a;
  var title = String(req.query.title || "video").replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "video";
  if (!v || !a) return res.status(400).send("Missing video/audio URL");

  try {
    var vh = new URL(v).hostname, ah = new URL(a).hostname;
    if (!/\.googlevideo\.com$/.test(vh) || !/\.googlevideo\.com$/.test(ah)) {
      return res.status(400).send("Invalid source host");
    }
  } catch (e) { return res.status(400).send("Invalid URL"); }

  var ff = spawn(ffmpegPath, [
    "-loglevel", "error",
    "-i", v,
    "-i", a,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1"
  ]);

  var started = false;
  var errLog = "";

  ff.stdout.once("data", function(first) {
    started = true;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="' + title + '.mp4"');
    res.write(first);
    ff.stdout.pipe(res);
  });

  ff.stderr.on("data", function(d) { if (errLog.length < 2000) errLog += d.toString(); });

  ff.on("error", function(e) {
    console.log("ffmpeg spawn error: " + e.message);
    if (!started) res.status(500).send("Merge failed to start: " + e.message);
    else res.end();
  });

  ff.on("close", function(codeNum) {
    if (codeNum !== 0) {
      console.log("ffmpeg exit " + codeNum + ": " + errLog.slice(0, 500));
      if (!started) {
        return res.status(500).send("Merge failed. Details: " + (errLog.slice(0, 300) || "unknown ffmpeg error"));
      }
    }
    res.end();
  });

  req.on("close", function() { ff.kill("SIGKILL"); });
});

app.get("/api/health", function(req, res) { res.json({ status: "ok" }); });
app.get("/", function(req, res) { res.sendFile(path.join(__dirname, "public", "index.html")); });
app.listen(PORT, function() { console.log("Server running on port " + PORT); });
