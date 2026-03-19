/**
 * SYNC DASHBOARD — Server Backend
 * Bản Độc Lập (Standalone) — Có thể deploy trên bất kỳ server/git nào
 * 
 * Chạy: npm start
 * Mở trình duyệt: http://localhost:4000
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.SYNC_DASHBOARD_PORT || 4000;

// ========== 1. MONGODB SETUP (Độc lập) ==========
const ImageCacheSchema = new mongoose.Schema({
    originalPath: { type: String, required: true, unique: true },
    r2Url: { type: String, required: true },
    r2Key: { type: String, required: true },
    contentType: { type: String, default: 'image/webp' },
    size: { type: Number, default: 0 },
    originalSize: { type: Number, default: 0 },
    syncedAt: { type: Date, default: Date.now },
}, { timestamps: true });
const ImageCache = mongoose.models.ImageCache || mongoose.model('ImageCache', ImageCacheSchema);

// ========== 2. CLOUDFLARE R2 SETUP (Độc lập) ==========
const s3Client = process.env.R2_ACCOUNT_ID ? new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
}) : null;

async function uploadToR2(key, body, contentType = 'image/jpeg') {
    if (!s3Client) return null;
    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME || 'pphim-images',
            Key: key, Body: body, ContentType: contentType,
            CacheControl: 'public, max-age=2592000, immutable',
        }));
        return `${process.env.R2_PUBLIC_URL}/${key}`;
    } catch (err) { return null; }
}

// ========== 3. SYNC ENGINE ==========
const OPHIM_BASE = 'https://ophim1.com';
const WEBP_QUALITY = 75;
const MAX_WIDTH = 800;
const CONCURRENT = 5;
const DELAY_BETWEEN_PAGES = 2000;

const syncState = {
    isRunning: false, shouldStop: false, currentPage: 0, totalPages: 0,
    stats: { total: 0, synced: 0, skipped: 0, failed: 0, savedKB: 0 },
    logs: [], startedAt: null, lastUpdate: null,
};

function addLog(msg) {
    const t = new Date().toLocaleTimeString('vi-VN');
    syncState.logs.push(`[${t}] ${msg}`);
    if (syncState.logs.length > 200) syncState.logs.shift();
    syncState.lastUpdate = Date.now();
    console.log(msg);
}

async function convertToWebP(buffer) {
    const { data } = await sharp(buffer)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY, effort: 4, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
    return data;
}

async function syncImage(imagePath) {
    syncState.stats.total++;
    try {
        const existing = await ImageCache.findOne({ originalPath: imagePath }).lean();
        if (existing) { syncState.stats.skipped++; return; }

        const response = await fetch(`https://img.ophim.live${imagePath}`, { headers: { 'user-agent': 'Mozilla/5.0' }, timeout: 30000 });
        if (!response.ok) { syncState.stats.failed++; addLog(`⚠️ Download lỗi: ${imagePath} (${response.status})`); return; }

        const buffer = await response.buffer();
        const originalSize = buffer.length;

        let webpBuffer;
        try { webpBuffer = await convertToWebP(buffer); } catch { webpBuffer = buffer; }

        let uploadBuffer = webpBuffer;
        let uploadContentType = 'image/webp';
        let r2Key = imagePath.replace(/^\/uploads\//, '').replace(/\.(jpg|jpeg|png|gif)$/i, '.webp');

        if (webpBuffer.length >= originalSize) {
            uploadBuffer = buffer; uploadContentType = response.headers.get('content-type') || 'image/jpeg';
            r2Key = imagePath.replace(/^\/uploads\//, '');
        }

        const r2Url = await uploadToR2(r2Key, uploadBuffer, uploadContentType);
        if (r2Url) {
            await ImageCache.findOneAndUpdate(
                { originalPath: imagePath },
                { originalPath: imagePath, r2Url, r2Key, contentType: uploadContentType, size: uploadBuffer.length, originalSize, syncedAt: new Date() },
                { upsert: true, new: true }
            );
            syncState.stats.synced++;
            syncState.stats.savedKB += (originalSize - uploadBuffer.length) / 1024;
            addLog(`✅ ${imagePath.split('/').pop()} | ${(originalSize/1024).toFixed(0)}KB → ${(uploadBuffer.length/1024).toFixed(0)}KB`);
        } else { syncState.stats.failed++; }
    } catch (err) { syncState.stats.failed++; addLog(`⚠️ Lỗi: ${imagePath} — ${err.message}`); }
}

async function syncPage(page) {
    if (syncState.shouldStop) return null;
    try {
        addLog(`📄 Trang ${page}...`);
        const response = await fetch(`${OPHIM_BASE}/v1/api/danh-sach/phim-moi?page=${page}`, { timeout: 15000 });
        if (!response.ok) return null;

        const data = await response.json();
        const items = data?.data?.items || [];
        if (items.length === 0) return null;

        syncState.totalPages = data?.data?.params?.pagination?.totalPages || 1;
        syncState.currentPage = page;

        const imagePaths = [];
        for (const item of items) {
            if (item.poster_url && !item.poster_url.startsWith('http')) imagePaths.push(item.poster_url.startsWith('/') ? item.poster_url : `/uploads/movies/${item.poster_url}`);
            if (item.thumb_url && !item.thumb_url.startsWith('http')) imagePaths.push(item.thumb_url.startsWith('/') ? item.thumb_url : `/uploads/movies/${item.thumb_url}`);
        }

        for (let i = 0; i < imagePaths.length; i += CONCURRENT) {
            if (syncState.shouldStop) break;
            const batch = imagePaths.slice(i, i + CONCURRENT);
            await Promise.allSettled(batch.map(p => syncImage(p)));
        }
        return syncState.totalPages;
    } catch (err) { addLog(`⚠️ Lỗi trang ${page}: ${err.message}`); return null; }
}

async function runSync() {
    if (syncState.isRunning) return;
    syncState.isRunning = true; syncState.shouldStop = false;
    syncState.stats = { total: 0, synced: 0, skipped: 0, failed: 0, savedKB: 0 };
    syncState.logs = []; syncState.startedAt = Date.now();

    addLog('🚀 BẮT ĐẦU SYNC ẢNH WEBP LÊN R2...');
    let page = 1; let totalPages = 1;

    while (page <= totalPages && !syncState.shouldStop) {
        const result = await syncPage(page);
        if (result === null) break;
        totalPages = Math.min(result, 50);
        page++;
        if (page <= totalPages && !syncState.shouldStop) await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
    }

    const s = syncState.stats;
    addLog(syncState.shouldStop ? '⏹️ ĐÃ DỪNG THEO YÊU CẦU' : '🎉 HOÀN THÀNH!');
    addLog(`📊 Tổng: ${s.total} | ✅ Sync: ${s.synced} | ⏭️ Skip: ${s.skipped} | ❌ Lỗi: ${s.failed} | 💾 Tiết kiệm: ${(s.savedKB/1024).toFixed(1)}MB`);

    syncState.isRunning = false; syncState.shouldStop = false;
}

// ========== 4. API ROUTES ==========
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', async (req, res) => {
    const totalOnR2 = await ImageCache.countDocuments().catch(() => 0);
    res.json({ ...syncState, totalOnR2 });
});
app.post('/api/start', (req, res) => {
    if (syncState.isRunning) return res.json({ ok: false, msg: 'Đang chạy rồi!' });
    runSync(); res.json({ ok: true, msg: 'Đã bắt đầu sync!' });
});
app.post('/api/stop', (req, res) => {
    if (!syncState.isRunning) return res.json({ ok: false, msg: 'Không có gì đang chạy.' });
    syncState.shouldStop = true; res.json({ ok: true, msg: 'Đang dừng...' });
});
app.post('/api/clear', async (req, res) => {
    if (syncState.isRunning) return res.json({ ok: false, msg: 'Không thể xóa khi đang sync!' });
    try {
        let deleted = 0, isTruncated = true, token = undefined;
        while (isTruncated) {
            const data = await s3Client.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME || 'pphim-images', ContinuationToken: token }));
            if (!data.Contents?.length) break;
            await Promise.allSettled(data.Contents.map(f => s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME || 'pphim-images', Key: f.Key })).then(() => deleted++)));
            isTruncated = data.IsTruncated; token = data.NextContinuationToken;
        }
        await ImageCache.deleteMany({});
        res.json({ ok: true, msg: `Đã xóa sạch ${deleted} ảnh trên R2 & MongoDB` });
    } catch (err) { res.json({ ok: false, msg: 'Lỗi: ' + err.message }); }
});

// ========== 5. KHỞI ĐỘNG ==========
async function start() {
    if (!process.env.MONGODB_URI) { console.error('❌ Thiếu biến môi trường. Vui lòng copy file .env.example thành .env và điền thông tin.'); process.exit(1); }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected');
    app.listen(PORT, '0.0.0.0', () => console.log(`\n🖥️ Sync Dashboard ĐỘC LẬP: http://localhost:${PORT}`));
}
start().catch(err => { console.error('❌', err); process.exit(1); });
