# YouTube Transcript Tool v2

Koi bhi YouTube video / shorts / youtu.be link se transcript banao — timestamps ke saath ya plain text. Copy ya download. Mobile + laptop dono par chalta hai.

## Features
- ✅ Dual engine: `youtubei.js` (primary) + `youtube-transcript` (fallback)
- ✅ 15 languages support (Urdu, Hindi, English, Arabic, Japanese, etc.)
- ✅ Auto-paste from clipboard jab input focus ho
- ✅ Word count + video duration dikhata hai
- ✅ Timestamps ke saath ya plain text toggle
- ✅ Copy + .txt download
- ✅ Mobile responsive

## Deploy on Render (Free, ~5 min)

### 1. GitHub par upload karo
```bash
git init
git add .
git commit -m "yt-transcript v2"
git branch -M main
git remote add origin https://github.com/<username>/yt-transcript-app.git
git push -u origin main
```

### 2. Render par deploy
- [render.com](https://render.com) → New + → Web Service
- GitHub repo connect karo
- Build: `npm install` | Start: `node server.js` | Plan: Free
- Deploy karo → `https://yt-transcript-app.onrender.com`

## Local chalana
```bash
npm install
node server.js
# http://localhost:3000
```

## Files
- `server.js` — backend (Express + youtubei.js + fallback)
- `public/index.html` — responsive dark UI
- `package.json` — dependencies
- `render.yaml` — Render auto-config

## Notes
- Sirf un videos par kaam karta hai jin par captions/subtitles enabled hain
- Auto-generated captions bhi theek hain
- Free Render plan 15 min idle ke baad sleep ho jata hai (pehli request ~30 sec slow)
