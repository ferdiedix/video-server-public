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
        backupChat: process.env.TELEGRAM_BACKUP_CHAT || '',
        useForumTopics: process.env.TELEGRAM_USE_FORUM_TOPICS === 'true'
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

async function listForumTopics(client, chat) {
    try {
        const result = await client.invoke(new Api.channels.GetForumTopics({
            channel: chat,
            limit: 100,
            offsetDate: 0,
            offsetId: 0,
            offsetTopic: 0
        }));
        const topics = (result.topics || []).filter(topic => topic && topic.id);
        return topics;
    } catch (error) {
        return null;
    }
}

function describeChat(entity) {
    if (!entity) return 'unknown';
    const className = entity.className || (entity.constructor ? entity.constructor.name : 'unknown');
    const title = entity.title || entity.username || entity.firstName || '';
    const username = entity.username ? `@${entity.username}` : '';
    const id = entity.id ? entity.id.toString() : '';
    return `${className} [${id}] ${title} ${username}`.trim();
}

async function getLinkedDiscussionGroup(client, chat) {
    try {
        if (!chat || !chat.id || chat.className !== 'Channel') return null;
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: chat }));
        const linkedChatId = full && full.fullChat ? full.fullChat.linkedChatId : null;
        if (!linkedChatId) return null;
        const linked = (full.chats || []).find(item => item && item.id && item.id.toString() === linkedChatId.toString());
        return linked || null;
    } catch {
        return null;
    }
}

async function listCandidateDialogs(client, hint) {
    try {
        const dialogs = await client.getDialogs({ limit: 200 });
        const matches = [];
        const keywords = ['backup', 'webaff', 'aff', 'video'];
        if (hint) keywords.push(hint.replace(/^@/, '').toLowerCase());
        for (const dialog of dialogs) {
            const entity = dialog.entity || dialog;
            const title = (entity.title || entity.username || entity.firstName || '').toLowerCase();
            const username = (entity.username || '').toLowerCase();
            const hit = keywords.some(kw => title.includes(kw) || username.includes(kw));
            if (hit) {
                matches.push(entity);
            }
        }
        return matches;
    } catch {
        return [];
    }
}

async function scanMessages(client, chat, { logger, replyTo = null, label = 'chat' } = {}) {
    const records = [];
    let processed = 0;
    let nonBackup = 0;
    let invalidJson = 0;

    const iterOptions = { limit: undefined };
    if (replyTo) iterOptions.replyTo = replyTo;

    try {
        for await (const message of client.iterMessages(chat, iterOptions)) {
            processed += 1;
            if (processed % 200 === 0) {
                logger(`[${label}] sudah memindai ${processed} pesan, ${records.length} backup ditemukan...`);
            }
            const caption = (message.message || message.text || '').toString();
            if (!caption) continue;
            if (!caption.trim().startsWith('WEBAPP_BACKUP')) {
                nonBackup += 1;
                continue;
            }
            const payload = parseBackupCaption(caption);
            if (!payload) {
                invalidJson += 1;
                continue;
            }
            records.push({
                messageId: message.id,
                payload,
                replyToTopMsgId: message.replyTo && message.replyTo.replyToTopId
                    ? message.replyTo.replyToTopId
                    : (message.replyTo && message.replyTo.replyToMsgId ? message.replyTo.replyToMsgId : null)
            });
        }
    } catch (error) {
        logger(`[${label}] error saat memindai: ${error.message || error}`);
    }

    logger(`[${label}] selesai. Total pesan: ${processed}, backup valid: ${records.length}, non-backup: ${nonBackup}, gagal parse JSON: ${invalidJson}.`);
    return records;
}

function chooseLatestPerVideo(records) {
    const map = new Map();
    for (const item of records) {
        const video = item.payload.video;
        if (!video || !video.id) continue;
        const existing = map.get(video.id);
        if (!existing || existing.messageId < item.messageId) {
            map.set(video.id, item);
        }
    }
    return [...map.values()];
}

async function rescan({ logger = msg => console.log(`[rescan] ${msg}`) } = {}) {
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

    logger(`Chat target: ${describeChat(chat)}`);

    const chatsToScan = [{ chat, label: 'primary' }];
    const linked = await getLinkedDiscussionGroup(client, chat);
    if (linked) {
        logger(`Channel terhubung dengan discussion group: ${describeChat(linked)}. Akan ikut dipindai.`);
        chatsToScan.push({ chat: linked, label: 'linked-discussion' });
    }

    const candidates = await listCandidateDialogs(client, config.backupChat);
    if (candidates.length) {
        logger(`Kandidat chat lain di akun yang mungkin terkait backup (untuk referensi):`);
        for (const candidate of candidates) {
            logger(`  - ${describeChat(candidate)}`);
        }
    }

    let allRecords = [];
    for (const target of chatsToScan) {
        const targetChat = target.chat;
        const baseLabel = target.label;
        const topics = await listForumTopics(client, targetChat);
        if (topics && topics.length) {
            logger(`[${baseLabel}] Forum topics terdeteksi: ${topics.length} topic. Memindai per topic plus general...`);
            for (const topic of topics) {
                const records = await scanMessages(client, targetChat, {
                    logger,
                    replyTo: topic.id,
                    label: `${baseLabel} topic ${topic.id} - ${topic.title || ''}`
                });
                allRecords = allRecords.concat(records);
            }
            const generalRecords = await scanMessages(client, targetChat, { logger, label: `${baseLabel} general` });
            allRecords = allRecords.concat(generalRecords);
        } else {
            logger(`[${baseLabel}] Bukan forum atau tidak ada topic. Memindai seluruh pesan chat...`);
            const records = await scanMessages(client, targetChat, { logger, label: `${baseLabel} chat` });
            allRecords = allRecords.concat(records);
        }
    }

    await client.disconnect();

    const filtered = chooseLatestPerVideo(allRecords);
    logger(`Total backup yang valid: ${allRecords.length}. Setelah dedup per video: ${filtered.length}.`);

    if (!filtered.length) {
        return {
            scannedMessages: allRecords.length,
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
        const messageId = item.messageId;
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
                topic: item.replyToTopMsgId
                    ? { topMessageId: item.replyToTopMsgId }
                    : (backupFolders[folderSnapshot.id] && backupFolders[folderSnapshot.id].topic) || null,
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

        const previousTelegram = (backupVideos[videoSnapshot.id] || {}).telegram || {};
        backupVideos[videoSnapshot.id] = {
            ...(backupVideos[videoSnapshot.id] || {}),
            status: 'backed_up',
            videoSnapshot: merged,
            folderSnapshot: folderSnapshot ? folderById.get(folderSnapshot.id) || folderSnapshot : null,
            telegram: {
                telegramChat: String(getConfig().backupChat),
                messageId,
                fileName: merged.fileName || merged.storedFileName,
                fileSize: previousTelegram.fileSize || null,
                backedUpAt: previousTelegram.backedUpAt || new Date().toISOString(),
                topic: item.replyToTopMsgId
                    ? { topMessageId: item.replyToTopMsgId }
                    : previousTelegram.topic || null
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
        scannedMessages: allRecords.length,
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
