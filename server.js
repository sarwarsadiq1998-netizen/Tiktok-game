require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLiveConnector } = require('tiktok-live-connector');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'target_streamer_username';

// تخزين مؤقت في الذاكرة (بدلاً من Redis)
let currentSessionId = 1;
let totalLikes = 0;
let topLikers = {}; // { userId: likeCount }
let weeklyStreamerLikes = {}; // { streamerId: weeklyLikes }
let streamerId = 1;
let streamerName = TIKTOK_USERNAME;

// إعدادات إضافية
let showGlobalLeaderboard = true;

app.use(express.static('public'));
app.use('/overlay', express.static('overlay'));
app.use(express.json());

// TikTok Live Connector
const tiktok = new TikTokLiveConnector();
tiktok.connect(TIKTOK_USERNAME);
tiktok.on('connected', () => console.log(`✅ متصل بـ ${TIKTOK_USERNAME}`));
tiktok.on('like', async (data) => {
    const userId = data.uniqueId;
    const likeCount = data.likeCount;
    
    // تحديث إجمالي اللايكات
    totalLikes += likeCount;
    
    // تحديث ترتيب المشاهدين
    if (!topLikers[userId]) topLikers[userId] = 0;
    topLikers[userId] += likeCount;
    
    // تحديث الترتيب الأسبوعي للستريمر (هذا الستريمر فقط)
    if (!weeklyStreamerLikes[streamerId]) weeklyStreamerLikes[streamerId] = 0;
    weeklyStreamerLikes[streamerId] += likeCount;
    
    // إرسال تحديث للمشاهدين
    const top5 = Object.entries(topLikers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => ({ id, count }));
    
    const otherStreamers = Object.entries(weeklyStreamerLikes)
        .filter(([id]) => parseInt(id) !== streamerId)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => ({ username: `streamer_${id}`, weekly_likes: count }));
    
    io.emit('live-update', { totalLikes, top5, otherStreamers });
});

// API endpoints
app.get('/api/streamer-name', (req, res) => res.json({ username: streamerName }));
app.get('/api/global-leaderboard', (req, res) => {
    const leaderboard = Object.entries(weeklyStreamerLikes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, likes]) => ({ username: `streamer_${id}`, weekly_likes: likes }));
    res.json(leaderboard);
});

// صفحة admin مبسطة
app.get('/admin', (req, res) => {
    res.send(`
        <html><body style="background:#222;color:#0f0;text-align:center;">
        <h1>لوحة تحكم البث</h1>
        <button onclick="fetch('/api/toggle-leaderboard', {method:'POST'})">تبديل التوب العالمي</button>
        <script>
            fetch('/api/toggle-leaderboard', {method:'POST'})
            .then(()=>alert('تم التبديل!'));
        </script>
        </body></html>
    `);
});
app.post('/api/toggle-leaderboard', (req, res) => {
    showGlobalLeaderboard = !showGlobalLeaderboard;
    io.emit('leaderboard-visibility', showGlobalLeaderboard);
    res.json({ show: showGlobalLeaderboard });
});

// Serve overlay
app.get('/overlay', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlay', 'index.html'));
});

// تكرار إرسال التوب العالمي كل 30 ثانية
setInterval(() => {
    const leaderboard = Object.entries(weeklyStreamerLikes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, likes]) => ({ username: `streamer_${id}`, weekly_likes: likes }));
    io.emit('update-global-leaderboard', leaderboard);
}, 30000);

// WebSocket connection
io.on('connection', (socket) => {
    const top5 = Object.entries(topLikers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => ({ id, count }));
    const otherStreamers = Object.entries(weeklyStreamerLikes)
        .filter(([id]) => parseInt(id) !== streamerId)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => ({ username: `streamer_${id}`, weekly_likes: count }));
    const leaderboard = Object.entries(weeklyStreamerLikes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, likes]) => ({ username: `streamer_${id}`, weekly_likes: likes }));
    
    socket.emit('live-update', { totalLikes, top5, otherStreamers });
    socket.emit('update-global-leaderboard', leaderboard);
    socket.emit('leaderboard-visibility', showGlobalLeaderboard);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 خادم اللعبة يعمل على http://localhost:${PORT}`);
});
