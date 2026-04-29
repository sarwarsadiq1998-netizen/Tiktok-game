require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const Redis = require('redis');
const cron = require('node-cron');
const { TikTokLiveConnector } = require('tiktok-live-connector');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const db = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

const redis = Redis.createClient({ url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}` });
redis.connect();

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;
let currentStreamerId = null;
let currentSessionId = null;
let showGlobalLeaderboard = process.env.SHOW_GLOBAL_LEADERBOARD === 'true';
let waveActive = false;
let waveMultiplier = 1;
let waveEndTime = 0;
let activeContest = null;

app.use(express.static('public'));
app.use('/overlay', express.static('overlay'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const upload = multer({ dest: 'uploads/' });

// TikTok connection
const tiktok = new TikTokLiveConnector();
tiktok.connect(TIKTOK_USERNAME);
tiktok.on('connected', () => console.log(`✅ Connected to ${TIKTOK_USERNAME}`));

tiktok.on('like', async (data) => {
    const viewerId = data.uniqueId;
    let likeCount = data.likeCount;
    if (waveActive && Date.now() < waveEndTime) likeCount *= waveMultiplier;
    const subRes = await db.query(`SELECT boost_multiplier FROM subscriptions WHERE user_id = $1 AND is_active = true AND end_date > NOW()`, [viewerId]);
    const boost = subRes.rows[0] ? subRes.rows[0].boost_multiplier : 1;
    const finalLikes = likeCount * boost;
    await redis.hincrby(`session:${currentSessionId}:likers`, viewerId, finalLikes);
    await redis.incrby(`session:${currentSessionId}:total_likes`, finalLikes);
    db.query(`INSERT INTO weekly_likes (streamer_id, week_start, weekly_likes) VALUES ($1, DATE_TRUNC('week', NOW()), $2) ON CONFLICT (streamer_id, week_start) DO UPDATE SET weekly_likes = weekly_likes + $2`, [currentStreamerId, finalLikes]);
    db.query(`UPDATE streamers SET total_likes_alltime = total_likes_alltime + $1 WHERE id = $2`, [finalLikes, currentStreamerId]);
    const totalLikes = await redis.get(`session:${currentSessionId}:total_likes`);
    const top5 = await getTop5Likers(currentSessionId);
    const otherStreamers = await fetchOtherStreamers(currentStreamerId);
    io.emit('live-update', { totalLikes: parseInt(totalLikes), top5, otherStreamers, waveActive: waveActive && Date.now() < waveEndTime, waveMultiplier });
    await checkWaveTrigger(parseInt(totalLikes));
});

tiktok.on('gift', async (data) => {
    const viewerId = data.uniqueId;
    const giftDiamonds = data.diamondCount;
    if (giftDiamonds >= 160) {
        await activateSubscription(viewerId, 'gems');
        io.emit('subscription-activated', { userId: viewerId, method: 'gems' });
    }
});

async function getTop5Likers(sessionId) {
    const likers = await redis.hGetAll(`session:${sessionId}:likers`);
    const sorted = Object.entries(likers).map(([id, count]) => ({ id, count: parseInt(count) }));
    sorted.sort((a, b) => b.count - a.count);
    return sorted.slice(0, 5);
}

async function fetchOtherStreamers(excludeStreamerId) {
    const res = await db.query(`SELECT s.username, w.weekly_likes FROM weekly_likes w JOIN streamers s ON w.streamer_id = s.id WHERE w.week_start = DATE_TRUNC('week', NOW()) AND s.id != $1 ORDER BY w.weekly_likes DESC LIMIT 5`, [excludeStreamerId]);
    return res.rows;
}

async function activateSubscription(userId, method) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    await db.query(`INSERT INTO subscriptions (user_id, is_active, end_date, boost_multiplier) VALUES ($1, true, $2, 2) ON CONFLICT (user_id) DO UPDATE SET is_active = true, end_date = $2, boost_multiplier = 2`, [userId, expiryDate]);
}

async function fetchGlobalLeaderboard() {
    const res = await db.query(`SELECT s.username, w.weekly_likes FROM weekly_likes w JOIN streamers s ON w.streamer_id = s.id WHERE w.week_start = DATE_TRUNC('week', NOW()) ORDER BY w.weekly_likes DESC LIMIT 20`);
    return res.rows;
}

async function checkWaveTrigger(totalLikes) {
    const thresholds = [1000, 2500, 5000, 10000, 20000];
    for (let th of thresholds) {
        if (totalLikes >= th && !waveActive) {
            waveActive = true;
            waveMultiplier = 2;
            waveEndTime = Date.now() + 30000;
            io.emit('wave-started', { multiplier: waveMultiplier, duration: 30 });
            setTimeout(() => {
                if (Date.now() >= waveEndTime) {
                    waveActive = false;
                    io.emit('wave-ended');
                }
            }, 30000);
            break;
        }
    }
}

function startContest(prizeMultiplier = 2, durationSec = 60) {
    const code = crypto.randomBytes(3).toString('hex');
    activeContest = { code, prizeMultiplier, endTime: Date.now() + durationSec * 1000, winners: [] };
    io.emit('contest-started', { code, prizeMultiplier, duration: durationSec });
    setTimeout(() => {
        if (activeContest && activeContest.endTime <= Date.now()) {
            io.emit('contest-ended', { winners: activeContest.winners });
            activeContest = null;
        }
    }, durationSec * 1000);
    return code;
}

async function generateWallOfFame() {
    const topViewers = await db.query(`SELECT user_id, SUM(likes_given) as total_likes FROM viewer_likes_archive WHERE week_start = DATE_TRUNC('week', NOW() - INTERVAL '1 week') GROUP BY user_id ORDER BY total_likes DESC LIMIT 3`);
    const topStreamers = await fetchGlobalLeaderboard();
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>شاشة الشهرة</title><style>body{background:black;color:gold;text-align:center;font-family:sans-serif;}</style></head><body><h1>🏆 شاشة الشهرة - الأسبوع الماضي 🏆</h1><h2>أفضل المشاهدين:</h2><ul>${topViewers.rows.map((v,i)=>`<li>${i+1}. ${v.user_id} - ${v.total_likes} لايك</li>`).join('')}</ul><h2>أفضل الستريمرز:</h2><ul>${topStreamers.map((s,i)=>`<li>${i+1}. @${s.username} - ${s.weekly_likes} لايك</li>`).join('')}</ul></body></html>`;
    fs.writeFileSync('public/wall.html', html);
}

async function startLiveSession(streamerUsername) {
    let res = await db.query(`SELECT id FROM streamers WHERE username = $1`, [streamerUsername]);
    if (res.rows.length === 0) res = await db.query(`INSERT INTO streamers (username) VALUES ($1) RETURNING id`, [streamerUsername]);
    currentStreamerId = res.rows[0].id;
    const sessionRes = await db.query(`INSERT INTO live_sessions (streamer_id) VALUES ($1) RETURNING id`, [currentStreamerId]);
    currentSessionId = sessionRes.rows[0].id;
    await redis.del(`session:${currentSessionId}:likers`);
    await redis.set(`session:${currentSessionId}:total_likes`, 0);
    console.log(`Started session for ${streamerUsername}`);
}

// Admin & API endpoints
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/wall', (req, res) => res.sendFile(path.join(__dirname, 'public/wall.html')));
app.post('/api/toggle-leaderboard', (req, res) => {
    if (req.body.secret === process.env.ADMIN_SECRET) {
        showGlobalLeaderboard = !showGlobalLeaderboard;
        io.emit('leaderboard-visibility', showGlobalLeaderboard);
        res.json({ success: true, show: showGlobalLeaderboard });
    } else res.status(403).json({ error: 'unauthorized' });
});
app.post('/api/start-contest', (req, res) => {
    if (req.body.secret === process.env.ADMIN_SECRET) {
        const code = startContest(req.body.multiplier || 2, req.body.duration || 60);
        res.json({ success: true, code });
    } else res.status(403).json({ error: 'unauthorized' });
});
app.post('/api/join-contest', async (req, res) => {
    const { userId, code } = req.body;
    if (activeContest && activeContest.code === code && Date.now() < activeContest.endTime && !activeContest.winners.includes(userId)) {
        activeContest.winners.push(userId);
        await db.query(`UPDATE subscriptions SET boost_multiplier = boost_multiplier * $1 WHERE user_id = $2`, [activeContest.prizeMultiplier, userId]);
        res.json({ success: true });
    } else res.json({ success: false });
});
app.post('/api/subscribe-card', async (req, res) => {
    try {
        const paymentIntent = await stripe.paymentIntents.create({ amount: 200, currency: 'usd', payment_method: req.body.paymentMethodId, confirm: true });
        if (paymentIntent.status === 'succeeded') {
            await activateSubscription(req.body.userId, 'card');
            res.json({ success: true });
        } else res.json({ success: false });
    } catch (err) { res.json({ success: false, error: err.message }); }
});
app.get('/api/streamer-name', (req, res) => res.json({ username: TIKTOK_USERNAME }));

io.on('connection', async (socket) => {
    if (currentSessionId) {
        const totalLikes = await redis.get(`session:${currentSessionId}:total_likes`) || 0;
        const top5 = await getTop5Likers(currentSessionId);
        const otherStreamers = await fetchOtherStreamers(currentStreamerId);
        const globalLeaderboard = await fetchGlobalLeaderboard();
        socket.emit('live-update', { totalLikes: parseInt(totalLikes), top5, otherStreamers, waveActive: waveActive && Date.now() < waveEndTime, waveMultiplier });
        socket.emit('update-global-leaderboard', globalLeaderboard);
        socket.emit('leaderboard-visibility', showGlobalLeaderboard);
        if (activeContest) socket.emit('contest-started', { code: activeContest.code, prizeMultiplier: activeContest.prizeMultiplier, duration: Math.floor((activeContest.endTime - Date.now())/1000) });
    }
});

cron.schedule('*/30 * * * * *', async () => {
    const leaderboard = await fetchGlobalLeaderboard();
    io.emit('update-global-leaderboard', leaderboard);
});
cron.schedule('0 0 * * 1', async () => {
    await generateWallOfFame();
    await db.query(`UPDATE weekly_likes SET weekly_likes = 0 WHERE week_start = DATE_TRUNC('week', NOW())`);
});

server.listen(process.env.PORT || 3000, async () => {
    console.log(`Server on port ${process.env.PORT || 3000}`);
    await startLiveSession(TIKTOK_USERNAME);
});
