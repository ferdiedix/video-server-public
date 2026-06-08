const fsNative = require('fs');
const fs = fsNative.promises;
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');
const TELEGRAM_BACKUPS_FILE = path.join(DATA_DIR, 'telegram-backups.json');

let TelegramClient;
let StringSession;
let Api;

function loadGramJs() {
    if (TelegramClient) return true;
    try {
        const telegram = require('telegram');
        TelegramClient = telegram.TelegramClient;
        Api = telegram.Api;
        StringSession = require('telegram/sessions').StringSession;
        return true;
    } catch (error) {
        console.error('Dependency telegram belum terpasang. Jalankan: npm install');
        return false;
    }
}

function getConfig() {
    return {
        apiId: Number(process.env.TELEGRAM_API_ID || 0),
        apiHash: process.env.TELEGRAM_API_HASH || '',
        session: process.env.TELEGRAM_SESSION || '',
        backupChat: process.env.TELEGRAM_BACKUP_CHAT || ''
    };
}

async function readJsonSafe(filePath, fallback) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

async function writeJson(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function parseBackupCaption(caption) {
    if (!caption || typeof caption !== 'string') return null;
    const trimmed = caption.trim();
    if (!trimmed.startsWith('WEBAPP_BACKUP')) return null;
    const newlineIndex = trimmed.indexOf('\n');
    if (newlineIndex < 0) return null;
    const jsonText = trimmed.slice(newlineIndex + 1).trim();
    try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || parsed.kind !== 'webaff-backup' || !parsed.video) return null;
        return parsed;
    } catch {
        return null;
    }
}

async function iterateBackupMessages(client, chat) {
    const messages = [];
    let offsetId = 0;
    const limit = 100;
    while (true) {
        const batch = await client.getMessages(chat, { limit, offsetId });
        if (!batch || !batch.length) break;
        for (const message of batch) {
            const caption = (message.message || message.text || '').toString();
            const payload = parseBackupCaption(caption);
            if (payload) {
                messages.push({ message, payload });
            }
            offsetId = message.id;
        }
        if (batch.length < limit) break;
    }
    return messages;
}

function chooseLatestPerVideo(records) {
    const map = new Map();
    for (const item of records) {
        const video = item.payload.video;
        if (!video || !video.id) continue;
        const existing = map.get(video.id);
        if (!existing || existing.message.id < item.message.id) {
            map.set(video.id, item);
        }
    }
    return [...map.values()];
}

async function rescan({ logger = console.log } = {}) {
    if (!loadGramJs()) {
        throw new Error('GramJS belum terpasang.');
    }

    const config = getConfig();
    if (!config.apiId || !config.apiHash || !config.session || !config.backupChat) {
        throw new Error('Konfigurasi Telegram belum lengkap. Pastikan TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_BACKUP_CHAT sudah diset.');
    }

    const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
        connectionRetries: 5
    });

    logger('Menghubungkan ke Telegram...');
    await client.connect();

    let chat;
    try {
        chat = await client.getEntity(config.backupChat);
    } catch (error) {
        await client.disconnect();
        throw new Error(`Gagal mengambil entity chat ${config.backupChat}: ${error.message || error}`);
    }

    logger(`Memindai pesan di ${config.backupChat}...`);
    let scanned;
    try {
        scanned = await iterateBackupMessages(client, chat);
    } catch (error) {
        await client.disconnect();
        throw new Error(`Gagal memindai pesan Telegram: ${error.message || error}`);
    }

    await client.disconnect();

    const filtered = chooseLatestPerVideo(scanned);
    logger(`Ditemukan ${filtered.length} video backup unik (dari ${scanned.length} pesan WEBAPP_BACKUP).`);

    if (!filtered.length) {
        return {
            scannedMessages: scanned.length,
            videoCount: 0,
            folderCount: 0,
            videos: [],
            folders: [],
            backups: { folders: {}, videos: {} }
        };
    }

    const existingVideos = await readJsonSafe(VIDEOS_FILE, []);
    const existingFolders = await readJsonSafe(FOLDERS_FILE, []);
    const existingBackups = await readJsonSafe(TELEGRAM_BACKUPS_FILE, { folders: {}, videos: {} });

    const videoById = new Map((existingVideos || []).filter(v => v && v.id).map(v => [v.id, v]));
    const folderById = new Map((existingFolders || []).filter(f => f && f.id).map(f => [f.id, f]));
    const backupVideos = { ...(existingBackups.videos || {}) };
    const backupFolders = { ...(existingBackups.folders || {}) };

    for (const item of filtered) {
        const payload = item.payload;
        const messageId = item.message.id;
        const videoSnapshot = payload.video;
        const folderSnapshot = payload.folder || null;

        if (folderSnapshot && folderSnapshot.id) {
            folderById.set(folderSnapshot.id, {
                ...(folderById.get(folderSnapshot.id) || {}),
                ...folderSnapshot,
                isEnabled: folderSnapshot.isEnabled !== false
            });
            backupFolders[folderSnapshot.id] = {
                ...(backupFolders[folderSnapshot.id] || {}),
                folderSnapshot,
                status: 'backed_up',
                updatedAt: new Date().toISOString()
            };
        }

        const previous = videoById.get(videoSnapshot.id) || {};
        const merged = {
            ...previous,
            ...videoSnapshot,
            adUrls: Array.isArray(videoSnapshot.adUrls) && videoSnapshot.adUrls.length
                ? videoSnapshot.adUrls
                : (previous.adUrls || (videoSnapshot.adUrl ? [videoSnapshot.adUrl] : [])),
            views: previous.views || 0,
            clicks: previous.clicks || 0,
            isEnabled: videoSnapshot.isEnabled !== false,
            createdAt: videoSnapshot.createdAt || previous.createdAt || new Date().toISOString()
        };
        if (!merged.fileName && videoSnapshot.fileName) merged.fileName = videoSnapshot.fileName;
        if (!merged.storedFileName) {
            merged.storedFileName = merged.fileName || merged.storedFileName || `${videoSnapshot.shortCode || videoSnapshot.id}.mp4`;
        }
        if (!merged.videoUrl && merged.shortCode) {
            const ext = path.extname(merged.storedFileName || '') || '.mp4';
            merged.videoUrl = `/u/${merged.shortCode}${ext}`;
        }
        videoById.set(videoSnapshot.id, merged);

        backupVideos[videoSnapshot.id] = {
            ...(backupVideos[videoSnapshot.id] || {}),
            status: 'backed_up',
            videoSnapshot: merged,
            folderSnapshot: folderSnapshot ? folderById.get(folderSnapshot.id) || folderSnapshot : null,
            telegram: {
                telegramChat: String(getConfig().backupChat),
                messageId,
                fileName: merged.fileName || merged.storedFileName,
                fileSize: null,
                backedUpAt: backupVideos[videoSnapshot.id] && backupVideos[videoSnapshot.id].telegram
                    ? backupVideos[videoSnapshot.id].telegram.backedUpAt
                    : new Date().toISOString(),
                topic: backupVideos[videoSnapshot.id] && backupVideos[videoSnapshot.id].telegram
                    ? backupVideos[videoSnapshot.id].telegram.topic || null
                    : null
            },
            updatedAt: new Date().toISOString()
        };
    }

    const folders = [...folderById.values()];
    const videos = [...videoById.values()].sort((a, b) => {
        const aTime = new Date(a.createdAt || 0).getTime();
        const bTime = new Date(b.createdAt || 0).getTime();
        return bTime - aTime;
    });

    await writeJson(FOLDERS_FILE, folders);
    await writeJson(VIDEOS_FILE, videos);
    await writeJson(TELEGRAM_BACKUPS_FILE, { folders: backupFolders, videos: backupVideos });

    return {
        scannedMessages: scanned.length,
        videoCount: filtered.length,
        folderCount: folders.length,
        videos,
        folders,
        backups: { folders: backupFolders, videos: backupVideos }
    };
}

if (require.main === module) {
    rescan({ logger: msg => console.log(`[rescan] ${msg}`) })
        .then(result => {
            console.log(`Selesai. Video: ${result.videoCount}, Folder: ${result.folderCount}`);
            console.log('File data sudah diperbarui. Buka admin lalu klik "Restore All" untuk mengunduh file video dari Telegram.');
            process.exit(0);
        })
        .catch(error => {
            console.error('Rescan gagal:', error.message || error);
            process.exit(1);
        });
}

module.exports = { rescan };
