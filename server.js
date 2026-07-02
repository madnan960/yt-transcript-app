const express = require("express");
const cors = require("cors");
const path = require("path");

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

function extractTikTokId(input) {
  if (!input) return null;
  const m = input.match(/video\/(\d+)/);
  return m ? m[1] : null;
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
  if
