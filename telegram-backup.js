const fsNative = require('fs');
const fs = fsNative.promises;
const path = require('path');

let TelegramClient;
let StringSession;
let Api;
let CustomFile;

function loadGramJs() {
    if (TelegramClient) return true;
    try {
        const telegram = require('telegram');
        TelegramClient = telegram.TelegramClient;
        Api = telegram.Api;
        StringSession = require('telegram/sessions').StringSession;
        CustomFile = require('telegram/client/uploads').CustomFile;
        return true;
    } catch {
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

function getStatus() {
    const config = getConfig();
    return {
        gramJsInstalled: loadGramJs(),
        configured: Boolean(config.apiId && config.apiHash && config.session && config.backupChat),
        apiId: Boolean(config.apiId),
        apiHash: Boolean(config.apiHash),
        session: Boolean(config.session),
        backupChat: config.backupChat ? String(config.backupChat) : '',
        useForumTopics: config.useForumTopics
    };
}

async function getClient() {
    if (!loadGramJs()) {
        throw new Error('Dependency telegram belum terinstall. Jalankan npm install.');
    }

    const config = getConfig();
    if (!config.apiId || !config.apiHash || !config.session || !config.backupChat) {
        throw new Error('Konfigurasi Telegram belum lengkap.');
    }

    const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
        connectionRetries: 5
    });
    await client.connect();
    return { client, config };
}

async function ensureForumTopic(client, chat, folder, existingTopic) {
    const config = getConfig();
    if (!config.useForumTopics) return existingTopic || null;
    if (existingTopic && existingTopic.topMessageId) return existingTopic;

    try {
        const result = await client.invoke(new Api.channels.CreateForumTopic({
            channel: chat,
            title: folder.title,
            randomId: BigInt(Date.now())
        }));
        const topicMessage = (result.updates || []).find(update => update.message && update.message.id);
        return {
            title: folder.title,
            topMessageId: topicMessage && topicMessage.message ? topicMessage.message.id : null,
            createdAt: new Date().toISOString()
        };
    } catch (error) {
        return {
            title: folder.title,
            topMessageId: null,
            error: error.message || 'Gagal membuat topic Telegram.',
            createdAt: new Date().toISOString()
        };
    }
}

function buildCaption(video, folder) {
    const payload = {
        kind: 'webaff-backup',
        version: 1,
        video: {
            id: video.id,
            shortCode: video.shortCode,
            title: video.title,
            fileName: video.fileName,
            videoUrl: video.videoUrl,
            adUrl: video.adUrl,
            adUrls: video.adUrls || [],
            requiredClicks: video.requiredClicks,
            isEnabled: video.isEnabled !== false,
            folderId: video.folderId || null
        },
        folder: folder ? {
            id: folder.id,
            shortCode: folder.shortCode,
            title: folder.title,
            isEnabled: folder.isEnabled !== false
        } : null
    };

    return `WEBAPP_BACKUP\n${JSON.stringify(payload)}`;
}

async function uploadVideoBackup({ video, folder, filePath, existingTopic }) {
    const { client, config } = await getClient();
    const chat = await client.getEntity(config.backupChat);
    const topic = folder ? await ensureForumTopic(client, chat, folder, existingTopic) : null;
    const stat = await fs.stat(filePath);
    const file = new CustomFile(video.fileName || path.basename(filePath), stat.size, filePath);
    const caption = buildCaption(video, folder);

    const options = {
        caption,
        forceDocument: false,
        workers: Number(process.env.TELEGRAM_UPLOAD_WORKERS || 4)
    };

    if (topic && topic.topMessageId) {
        options.replyTo = topic.topMessageId;
    }

    const message = await client.sendFile(chat, {
        file,
        ...options
    });

    await client.disconnect();

    return {
        telegramChat: String(config.backupChat),
        messageId: message.id,
        topic,
        fileName: video.fileName || path.basename(filePath),
        fileSize: stat.size,
        backedUpAt: new Date().toISOString()
    };
}

async function restoreVideoBackup({ backup, outputPath, onProgress }) {
    const { client, config } = await getClient();
    const chat = await client.getEntity(config.backupChat || backup.telegramChat);
    const messages = await client.getMessages(chat, { ids: [backup.messageId] });
    const message = Array.isArray(messages) ? messages[0] : messages;
    if (!message) {
        throw new Error('Message backup Telegram tidak ditemukan.');
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const downloadOptions = { outputFile: outputPath };
    if (typeof onProgress === 'function') {
        downloadOptions.progressCallback = (received, total) => {
            try {
                const got = Number(received && received.toJSNumber ? received.toJSNumber() : received) || 0;
                const totalNum = Number(total && total.toJSNumber ? total.toJSNumber() : total) || 0;
                onProgress(got, totalNum);
            } catch {
                // ignore progress callback errors
            }
        };
    }

    await client.downloadMedia(message, downloadOptions);
    await client.disconnect();

    return {
        restoredAt: new Date().toISOString(),
        outputPath
    };
}

module.exports = {
    getStatus,
    uploadVideoBackup,
    restoreVideoBackup
};
