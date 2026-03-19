/**
 * SYNC DASHBOARD — Server Backend
 * Web dashboard để theo dõi tiến độ bulk sync ảnh WebP lên R2
 * 
 * Chạy: npm start (hoặc node server.js)
 * Mở trình duyệt: http://localhost:4000
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
const sharp = require('sharp');

// Tái sử dụng models và utils từ project chính
const ImageCache = require('../src/models/ImageCache');
const { uploadToR2, isR2Configured } = require('../src/utils/r2');

const app = express();
const PORT = process.env.SYNC_DASHBOARD_PORT || 4000;

// ========== SYNC ENGINE ==========
const OPHIM_BASE = 'https://ophim1.com';
const WEBP_QUALITY = 75;
const MAX_WIDTH = 800;
const CONCURRENT = 5;
const DELAY_BETWEEN_PAGES = 2000;

// Trạng thái sync (real-time)
const syncState = {
    isRunning: false,
    shouldStop: false,
    currentPage: 0,
    totalPages: 0,
    stats: { total: 0, synced: 0, skipped: 0, failed: 0, savedKB: 0 },
    logs: [],        // Logs mới nhất (giữ 200 dòng)
    startedAt: null,
    lastUpdate: null,
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString('vi-VN');
    syncState.logs.push(`[${time}] ${msg}`);
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

        const sourceUrl = `https://img.ophim.live${imagePath}`;
        const response = await fetch(sourceUrl, {
            headers: { 'user-agent': 'Mozilla/5.0' },
            timeout: 30000,
        });
        if (!response.ok) {
            syncState.stats.failed++;
            addLog(`⚠️ Download lỗi: ${imagePath} (${response.status})`);
            return;
        }

        const buffer = await response.buffer();
        const originalSize = buffer.length;

        let webpBuffer;
        try { webpBuffer = await convertToWebP(buffer); }
        catch { webpBuffer = buffer; }

        let uploadBuffer = webpBuffer;
        let uploadContentType = 'image/webp';
        let r2Key = imagePath.replace(/^\/uploads\//, '').replace(/\.(jpg|jpeg|png|gif)$/i, '.webp');

        if (webpBuffer.length >= originalSize) {
            uploadBuffer = buffer;
            uploadContentType = response.headers.get('content-type') || 'image/jpeg';
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
            const pct = ((1 - uploadBuffer.length / originalSize) * 100).toFixed(0);
            addLog(`✅ ${imagePath.split('/').pop()} | ${(originalSize/1024).toFixed(0)}KB → ${(uploadBuffer.length/1024).toFixed(0)}KB (${pct}%)`);
        } else { syncState.stats.failed++; }
    } catch (err) {
        syncState.stats.failed++;
        addLog(`⚠️ Lỗi: ${imagePath} — ${err.message}`);
    }
}

async function syncPage(page) {
    if (syncState.shouldStop) return null;
    try {
        const url = `${OPHIM_BASE}/v1/api/danh-sach/phim-moi?page=${page}`;
        addLog(`📄 Trang ${page}...`);
        const response = await fetch(url, { timeout: 15000 });
        if (!response.ok) return null;

        const data = await response.json();
        const items = data?.data?.items || [];
        if (items.length === 0) return null;

        const totalPages = data?.data?.params?.pagination?.totalPages || 1;
        syncState.totalPages = totalPages;
        syncState.currentPage = page;

        const imagePaths = [];
        for (const item of items) {
            if (item.poster_url && !item.poster_url.startsWith('http')) {
                imagePaths.push(item.poster_url.startsWith('/') ? item.poster_url : `/uploads/movies/${item.poster_url}`);
            }
            if (item.thumb_url && !item.thumb_url.startsWith('http')) {
                imagePaths.push(item.thumb_url.startsWith('/') ? item.thumb_url : `/uploads/movies/${item.thumb_url}`);
            }
        }

        for (let i = 0; i < imagePaths.length; i += CONCURRENT) {
            if (syncState.shouldStop) break;
            const batch = imagePaths.slice(i, i + CONCURRENT);
            await Promise.allSettled(batch.map(p => syncImage(p)));
        }

        return totalPages;
    } catch (err) {
        addLog(`⚠️ Lỗi trang ${page}: ${err.message}`);
        return null;
    }
}

async function runSync() {
    if (syncState.isRunning) return;
    syncState.isRunning = true;
    syncState.shouldStop = false;
    syncState.stats = { total: 0, synced: 0, skipped: 0, failed: 0, savedKB: 0 };
    syncState.logs = [];
    syncState.startedAt = Date.now();

    addLog('🚀 BẮT ĐẦU SYNC ẢNH WEBP LÊN R2...');

    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && !syncState.shouldStop) {
        const result = await syncPage(page);
        if (result === null) break;
        totalPages = Math.min(result, 50);
        page++;
        if (page <= totalPages && !syncState.shouldStop) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
        }
    }

    const s = syncState.stats;
    addLog(syncState.shouldStop ? '⏹️ ĐÃ DỪNG THEO YÊU CẦU' : '🎉 HOÀN THÀNH!');
    addLog(`📊 Tổng: ${s.total} | ✅ Sync: ${s.synced} | ⏭️ Skip: ${s.skipped} | ❌ Lỗi: ${s.failed} | 💾 Tiết kiệm: ${(s.savedKB/1024).toFixed(1)}MB`);

    syncState.isRunning = false;
    syncState.shouldStop = false;
}

// ========== API ROUTES ==========
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', async (req, res) => {
    const totalOnR2 = await ImageCache.countDocuments().catch(() => 0);
    res.json({ ...syncState, totalOnR2 });
});

app.post('/api/start', (req, res) => {
    if (syncState.isRunning) return res.json({ ok: false, msg: 'Đang chạy rồi!' });
    runSync(); // Fire and forget
    res.json({ ok: true, msg: 'Đã bắt đầu sync!' });
});

app.post('/api/stop', (req, res) => {
    if (!syncState.isRunning) return res.json({ ok: false, msg: 'Không có gì đang chạy.' });
    syncState.shouldStop = true;
    res.json({ ok: true, msg: 'Đang dừng...' });
});

app.post('/api/clear', async (req, res) => {
    if (syncState.isRunning) return res.json({ ok: false, msg: 'Không thể xóa khi đang sync!' });
    try {
        const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
        const s3 = new S3Client({
            region: 'auto',
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
        });
        let deleted = 0, isTruncated = true, token = undefined;
        while (isTruncated) {
            const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME || 'pphim-images', ContinuationToken: token }));
            if (!data.Contents?.length) break;
            await Promise.allSettled(data.Contents.map(f => s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME || 'pphim-images', Key: f.Key })).then(() => deleted++)));
            isTruncated = data.IsTruncated;
            token = data.NextContinuationToken;
        }
        await ImageCache.deleteMany({});
        res.json({ ok: true, msg: `Đã xóa ${deleted} files trên R2 + MongoDB` });
    } catch (err) {
        res.json({ ok: false, msg: 'Lỗi: ' + err.message });
    }
});

// ========== KHỞI ĐỘNG ==========
async function start() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected');
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🖥️ Sync Dashboard: http://localhost:${PORT}`);
    });
}

start().catch(err => { console.error('❌', err); process.exit(1); });
