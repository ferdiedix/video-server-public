const http = require('http');
const fsNative = require('fs');
const fs = fsNative.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const childProcess = require('child_process');
const telegramBackup = require('./telegram-backup');
const telegramRescan = require('./telegram-rescan');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const IMAGE_DIR = path.join(ROOT, 'images');
const THUMB_DIR = path.join(ROOT, 'thumbnails');
const DATA_FILE = path.join(DATA_DIR, 'videos.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');
const LINK_BANK_FILE = path.join(DATA_DIR, 'link-bank.json');
const VISITORS_FILE = path.join(DATA_DIR, 'visitors.json');
const TELEGRAM_BACKUPS_FILE = path.join(DATA_DIR, 'telegram-backups.json');
const IMAGES_FILE = path.join(DATA_DIR, 'images.json');
const TELEGRAM_BOT_FILE = path.join(DATA_DIR, 'telegram-bot.json');
const SECURITY_FILE = path.join(DATA_DIR, 'security.json');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const MAX_JSON_BYTES = 1000 * 1024 * 1024;
const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_MS = 24 * 60 * 60 * 1000;
const IS_ANDROID = process.platform === 'android'
    || /android|termux/i.test(process.env.PREFIX || '')
    || /com\.termux/i.test(process.env.HOME || '');
const DEFAULT_COMPRESS_CPU = IS_ANDROID ? 30 : 50;
const DEFAULT_COMPRESS_PRESET = IS_ANDROID ? 'fast' : 'medium';
const COMPRESS_MIN_BYTES = Number(process.env.COMPRESS_MIN_BYTES || 100 * 1024 * 1024);
const COMPRESS_CRF = String(process.env.COMPRESS_CRF || '23');
const COMPRESS_PRESET = String(process.env.COMPRESS_PRESET || DEFAULT_COMPRESS_PRESET);
const COMPRESS_AUDIO_BITRATE = String(process.env.COMPRESS_AUDIO_BITRATE || '128k');
const COMPRESS_MIN_SAVING_RATIO = Math.max(0, Math.min(0.95, Number(process.env.COMPRESS_MIN_SAVING || 0.15)));
const COMPRESS_CPU_PERCENT = Math.max(10, Math.min(100, Number(process.env.COMPRESS_CPU_PERCENT || DEFAULT_COMPRESS_CPU)));
const COMPRESS_NICENESS = Math.max(0, Math.min(19, Number(process.env.COMPRESS_NICENESS || 10)));

const sessions = new Map();
const uploadSessions = new Map();
const thumbnailGenerations = new Map();
let lastNetworkSample = null;
let telegramBackupQueue = Promise.resolve();
let videoCompressionQueue = Promise.resolve();
const videoCompressionPending = new Set();
const compressionState = {
    queue: [],
    history: [],
    current: null
};
let videoRestoreQueue = Promise.resolve();
const videoRestorePending = new Set();
const restoreState = {
    queue: [],
    history: [],
    current: null
};
let mediaFileNameMigrationPromise = null;

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
};

async function ensureStorage() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.mkdir(IMAGE_DIR, { recursive: true });
    await fs.mkdir(THUMB_DIR, { recursive: true });

    try {
        await fs.access(DATA_FILE);
    } catch {
        await fs.writeFile(DATA_FILE, '[]\n', 'utf8');
    }

    try {
        await fs.access(FOLDERS_FILE);
    } catch {
        await fs.writeFile(FOLDERS_FILE, '[]\n', 'utf8');
    }

    try {
        await fs.access(LINK_BANK_FILE);
    } catch {
        await fs.writeFile(LINK_BANK_FILE, '[]\n', 'utf8');
    }

    try {
        await fs.access(VISITORS_FILE);
    } catch {
        await fs.writeFile(VISITORS_FILE, '[]\n', 'utf8');
    }

    try {
        await fs.access(TELEGRAM_BACKUPS_FILE);
    } catch {
        await fs.writeFile(TELEGRAM_BACKUPS_FILE, '{"folders":{},"videos":{}}\n', 'utf8');
    }

    try {
        await fs.access(IMAGES_FILE);
    } catch {
        await fs.writeFile(IMAGES_FILE, '[]\n', 'utf8');
    }

    try {
        await fs.access(TELEGRAM_BOT_FILE);
    } catch {
        await fs.writeFile(TELEGRAM_BOT_FILE, '{"botToken":"","chatId":""}\n', 'utf8');
    }

    try {
        await fs.access(SECURITY_FILE);
    } catch {
        await fs.writeFile(SECURITY_FILE, '{"loginAttempts":{}}\n', 'utf8');
    }
}

async function readVideos() {
    await ensureStorage();
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    try {
        const videos = JSON.parse(raw);
        return await migrateVideos(videos);
    } catch {
        return [];
    }
}

async function saveVideos(videos) {
    await ensureStorage();
    await fs.writeFile(DATA_FILE, JSON.stringify(videos, null, 2) + '\n', 'utf8');
}

async function readFolders() {
    await ensureStorage();
    const raw = await fs.readFile(FOLDERS_FILE, 'utf8');
    try {
        const folders = JSON.parse(raw);
        return await migrateFolders(folders);
    } catch {
        return [];
    }
}

async function saveFolders(folders) {
    await ensureStorage();
    await fs.writeFile(FOLDERS_FILE, JSON.stringify(folders, null, 2) + '\n', 'utf8');
}

async function readLinkBank() {
    await ensureStorage();
    const raw = await fs.readFile(LINK_BANK_FILE, 'utf8');
    try {
        const links = JSON.parse(raw);
        return Array.isArray(links) ? links : [];
    } catch {
        return [];
    }
}

async function saveLinkBank(links) {
    await ensureStorage();
    await fs.writeFile(LINK_BANK_FILE, JSON.stringify(links, null, 2) + '\n', 'utf8');
}

async function readVisitors() {
    await ensureStorage();
    const raw = await fs.readFile(VISITORS_FILE, 'utf8');
    try {
        const visitors = JSON.parse(raw);
        return Array.isArray(visitors) ? visitors : [];
    } catch {
        return [];
    }
}

async function saveVisitors(visitors) {
    await ensureStorage();
    await fs.writeFile(VISITORS_FILE, JSON.stringify(visitors.slice(0, 2000), null, 2) + '\n', 'utf8');
}

async function readImages() {
    await ensureStorage();
    const raw = await fs.readFile(IMAGES_FILE, 'utf8');
    try {
        const images = JSON.parse(raw);
        return Array.isArray(images) ? images : [];
    } catch {
        return [];
    }
}

async function saveImages(images) {
    await ensureStorage();
    await fs.writeFile(IMAGES_FILE, JSON.stringify(images, null, 2) + '\n', 'utf8');
}

async function readTelegramBotConfig() {
    await ensureStorage();
    try {
        const raw = await fs.readFile(TELEGRAM_BOT_FILE, 'utf8');
        const config = JSON.parse(raw);
        return {
            botToken: config.botToken || '',
            chatId: config.chatId || ''
        };
    } catch {
        return { botToken: '', chatId: '' };
    }
}

async function saveTelegramBotConfig(config) {
    await ensureStorage();
    await fs.writeFile(TELEGRAM_BOT_FILE, JSON.stringify({
        botToken: config.botToken || '',
        chatId: config.chatId || ''
    }, null, 2) + '\n', 'utf8');
}

function sanitizeTelegramBotConfig(config) {
    const token = config.botToken || '';
    return {
        configured: Boolean(token && config.chatId),
        hasToken: Boolean(token),
        tokenPreview: token ? `${token.slice(0, 8)}...${token.slice(-5)}` : '',
        chatId: config.chatId || ''
    };
}

async function readTelegramBackups() {
    await ensureStorage();
    try {
        const raw = await fs.readFile(TELEGRAM_BACKUPS_FILE, 'utf8');
        const data = JSON.parse(raw);
        return {
            folders: data.folders || {},
            videos: data.videos || {}
        };
    } catch {
        return { folders: {}, videos: {} };
    }
}

async function saveTelegramBackups(data) {
    await ensureStorage();
    await fs.writeFile(TELEGRAM_BACKUPS_FILE, JSON.stringify({
        folders: data.folders || {},
        videos: data.videos || {}
    }, null, 2) + '\n', 'utf8');
}

async function updateBackupRecord(videoId, patch) {
    const backups = await readTelegramBackups();
    backups.videos[videoId] = {
        ...(backups.videos[videoId] || {}),
        ...patch,
        updatedAt: new Date().toISOString()
    };
    await saveTelegramBackups(backups);
    return backups.videos[videoId];
}

function enqueueTelegramBackup(task) {
    const run = telegramBackupQueue.then(task, task);
    telegramBackupQueue = run.catch(error => {
        console.error('[telegram-backup]', error && error.message ? error.message : error);
    });
    return run;
}

async function scheduleTelegramBackup(video) {
    const status = telegramBackup.getStatus();
    const filePath = getVideoFilePath(video);
    const folders = await readFolders();
    const folder = video.folderId ? folders.find(item => item.id === video.folderId) : null;
    const backups = await readTelegramBackups();

    backups.videos[video.id] = {
        ...(backups.videos[video.id] || {}),
        status: status.configured ? 'queued' : 'config_missing',
        videoSnapshot: video,
        folderSnapshot: folder || null,
        filePath,
        updatedAt: new Date().toISOString()
    };

    if (folder) {
        backups.folders[folder.id] = {
            ...(backups.folders[folder.id] || {}),
            folderSnapshot: folder,
            status: status.configured ? 'queued' : 'config_missing',
            updatedAt: new Date().toISOString()
        };
    }

    await saveTelegramBackups(backups);
    if (!status.configured) return;

    setTimeout(() => {
        enqueueTelegramBackup(async () => {
            await updateBackupRecord(video.id, { status: 'uploading', startedAt: new Date().toISOString() });
            const latestBackups = await readTelegramBackups();
            const folderRecord = folder ? latestBackups.folders[folder.id] : null;
            const result = await telegramBackup.uploadVideoBackup({
                video,
                folder,
                filePath,
                existingTopic: folderRecord && folderRecord.topic ? folderRecord.topic : null
            });

            latestBackups.videos[video.id] = {
                ...(latestBackups.videos[video.id] || {}),
                status: 'backed_up',
                telegram: result,
                videoSnapshot: video,
                folderSnapshot: folder || null,
                backedUpAt: result.backedUpAt,
                updatedAt: new Date().toISOString()
            };

            if (folder) {
                latestBackups.folders[folder.id] = {
                    ...(latestBackups.folders[folder.id] || {}),
                    status: 'backed_up',
                    folderSnapshot: folder,
                    topic: result.topic || null,
                    updatedAt: new Date().toISOString()
                };
            }

            await saveTelegramBackups(latestBackups);
        }).catch(error => updateBackupRecord(video.id, {
            status: 'failed',
            error: error.message || 'Backup Telegram gagal.'
        }).catch(() => {}));
    }, 100);
}

function execCommand(command) {
    return new Promise(resolve => {
        childProcess.exec(command, { timeout: 2500 }, (error, stdout) => {
            if (error) {
                resolve('');
                return;
            }
            resolve(stdout || '');
        });
    });
}

let rootAvailability = null;
async function hasRootAccess() {
    if (rootAvailability !== null) return rootAvailability;
    try {
        const out = await new Promise(resolve => {
            childProcess.exec('su -c id', { timeout: 4000 }, (error, stdout) => {
                if (error) {
                    resolve('');
                    return;
                }
                resolve(stdout || '');
            });
        });
        rootAvailability = /uid=0/.test(out);
    } catch {
        rootAvailability = false;
    }
    if (rootAvailability) {
        console.log('[root] su access granted - elevated /proc reads enabled.');
    }
    return rootAvailability;
}

function execCommandRoot(command) {
    return new Promise(resolve => {
        childProcess.exec(`su -c ${JSON.stringify(command)}`, { timeout: 4000 }, (error, stdout) => {
            if (error) {
                resolve('');
                return;
            }
            resolve(stdout || '');
        });
    });
}

async function getStorageStatus() {
    const output = await execCommand(`df -k "${ROOT}"`);
    const lines = output.trim().split(/\r?\n/);
    if (lines.length < 2) {
        return null;
    }

    const dataLine = lines.slice(1).join(' ');
    const parts = dataLine.trim().split(/\s+/);
    if (parts.length < 4) {
        return null;
    }

    let total;
    let used;
    let free;
    let mount;
    if (parts.length >= 6) {
        total = Number(parts[1]) * 1024;
        used = Number(parts[2]) * 1024;
        free = Number(parts[3]) * 1024;
        mount = parts[5];
    } else {
        total = Number(parts[parts.length - 4]) * 1024;
        used = Number(parts[parts.length - 3]) * 1024;
        free = Number(parts[parts.length - 2]) * 1024;
        mount = parts[parts.length - 1];
    }

    if (!Number.isFinite(total) || total <= 0) {
        return null;
    }

    return {
        total,
        used,
        free,
        percent: total ? Math.round((used / total) * 100) : 0,
        mount
    };
}

async function readNetworkCounters() {
    // 0) root su -c cat /proc/net/dev (kalau root tersedia)
    if (IS_ANDROID && await hasRootAccess()) {
        try {
            const raw = await execCommandRoot('cat /proc/net/dev');
            if (raw && raw.trim()) {
                const lines = raw.split(/\r?\n/).slice(2);
                let rx = 0;
                let tx = 0;
                let parsed = false;
                for (const line of lines) {
                    const cleaned = line.trim();
                    if (!cleaned || cleaned.startsWith('lo:')) continue;
                    const parts = cleaned.replace(':', ' ').trim().split(/\s+/);
                    const r = Number(parts[1] || 0);
                    const t = Number(parts[9] || 0);
                    if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
                    rx += r;
                    tx += t;
                    parsed = true;
                }
                if (parsed) return { rx, tx, source: 'su-proc-net-dev' };
            }
        } catch {
            // ignore
        }
    }

    // 1) /proc/net/dev (works on most Linux/Termux when accessible)
    try {
        const raw = await fs.readFile('/proc/net/dev', 'utf8');
        const lines = raw.split(/\r?\n/).slice(2);
        let rx = 0;
        let tx = 0;
        let parsed = false;
        for (const line of lines) {
            const cleaned = line.trim();
            if (!cleaned || cleaned.startsWith('lo:')) continue;
            const parts = cleaned.replace(':', ' ').trim().split(/\s+/);
            const r = Number(parts[1] || 0);
            const t = Number(parts[9] || 0);
            if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
            rx += r;
            tx += t;
            parsed = true;
        }
        if (parsed) return { rx, tx, source: 'proc-net-dev' };
    } catch {
        // ignore
    }

    // 2) /sys/class/net/<iface>/statistics/{rx,tx}_bytes (Android-friendly)
    try {
        const interfaces = await fs.readdir('/sys/class/net');
        let rx = 0;
        let tx = 0;
        let parsed = false;
        for (const iface of interfaces) {
            if (iface === 'lo') continue;
            try {
                const rxRaw = await fs.readFile(`/sys/class/net/${iface}/statistics/rx_bytes`, 'utf8');
                const txRaw = await fs.readFile(`/sys/class/net/${iface}/statistics/tx_bytes`, 'utf8');
                const r = Number(String(rxRaw).trim());
                const t = Number(String(txRaw).trim());
                if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
                rx += r;
                tx += t;
                parsed = true;
            } catch {
                // skip iface
            }
        }
        if (parsed) return { rx, tx, source: 'sysfs' };
    } catch {
        // ignore
    }

    // 3) /proc/net/xt_qtaguid/iface_stat_fmt (older Android)
    try {
        const raw = await fs.readFile('/proc/net/xt_qtaguid/iface_stat_fmt', 'utf8');
        const lines = raw.split(/\r?\n/).slice(1);
        let rx = 0;
        let tx = 0;
        let parsed = false;
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 5) continue;
            if (parts[0] === 'lo') continue;
            const r = Number(parts[1]);
            const t = Number(parts[3]);
            if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
            rx += r;
            tx += t;
            parsed = true;
        }
        if (parsed) return { rx, tx, source: 'qtaguid' };
    } catch {
        // ignore
    }

    // 4) `ip -s link` shell output (Termux fallback)
    try {
        const out = await execCommand('ip -s -o link');
        if (out && out.trim()) {
            let rx = 0;
            let tx = 0;
            let parsed = false;
            const lines = out.split(/\r?\n/);
            for (const line of lines) {
                if (!line || line.includes(' lo ')) continue;
                const numericGroups = line.match(/(\d+(?:\s+\d+)+)/g);
                if (!numericGroups || numericGroups.length < 2) continue;
                const rxNumbers = numericGroups[0].split(/\s+/).map(Number);
                const txNumbers = numericGroups[1].split(/\s+/).map(Number);
                if (!rxNumbers.length || !txNumbers.length) continue;
                rx += Number(rxNumbers[0] || 0);
                tx += Number(txNumbers[0] || 0);
                parsed = true;
            }
            if (parsed) return { rx, tx, source: 'ip-link' };
        }
    } catch {
        // ignore
    }

    // 5) Per-process counters: sum delta of node + ffmpeg from /proc/<pid>/net/dev (rare path)
    try {
        const out = await execCommand(`cat /proc/${process.pid}/net/dev 2>/dev/null`);
        if (out && out.trim()) {
            const lines = out.split(/\r?\n/).slice(2);
            let rx = 0;
            let tx = 0;
            let parsed = false;
            for (const line of lines) {
                const cleaned = line.trim();
                if (!cleaned || cleaned.startsWith('lo:')) continue;
                const parts = cleaned.replace(':', ' ').trim().split(/\s+/);
                const r = Number(parts[1] || 0);
                const t = Number(parts[9] || 0);
                if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
                rx += r;
                tx += t;
                parsed = true;
            }
            if (parsed) return { rx, tx, source: 'proc-pid-net-dev' };
        }
    } catch {
        // ignore
    }

    return null;
}

async function getNetworkSample() {
    const counters = await readNetworkCounters();
    if (!counters) {
        return { rx: 0, tx: 0, rxPerSecond: 0, txPerSecond: 0, available: false, source: 'none' };
    }

    const now = Date.now();
    const previous = lastNetworkSample;
    lastNetworkSample = { rx: counters.rx, tx: counters.tx, at: now };

    if (!previous) {
        return { rx: counters.rx, tx: counters.tx, rxPerSecond: 0, txPerSecond: 0, available: true, source: counters.source };
    }

    const seconds = Math.max(1, (now - previous.at) / 1000);
    const rxDelta = counters.rx - previous.rx;
    const txDelta = counters.tx - previous.tx;
    return {
        rx: counters.rx,
        tx: counters.tx,
        rxPerSecond: Math.max(0, Math.round(rxDelta / seconds)),
        txPerSecond: Math.max(0, Math.round(txDelta / seconds)),
        available: true,
        source: counters.source
    };
}

function detectCpuCount() {
    const fromOs = os.cpus().length || 0;
    if (fromOs > 1) return fromOs;

    try {
        const possibleEntries = fsNative.readdirSync('/sys/devices/system/cpu');
        const matches = possibleEntries.filter(name => /^cpu\d+$/.test(name));
        if (matches.length > 0) return matches.length;
    } catch {
        // ignore
    }

    try {
        const cpuinfo = fsNative.readFileSync('/proc/cpuinfo', 'utf8');
        const processors = cpuinfo.split(/\r?\n/).filter(line => /^processor\s*:/i.test(line));
        if (processors.length > 0) return processors.length;
    } catch {
        // ignore
    }

    return Math.max(1, fromOs);
}

let lastCpuStatSample = null;

function readAggregateCpuStat() {
    try {
        const raw = fsNative.readFileSync('/proc/stat', 'utf8');
        const firstLine = raw.split(/\r?\n/, 1)[0] || '';
        const parts = firstLine.trim().split(/\s+/);
        if (parts[0] !== 'cpu') return null;
        const numbers = parts.slice(1).map(value => Number(value || 0));
        const total = numbers.reduce((sum, value) => sum + value, 0);
        const idle = (numbers[3] || 0) + (numbers[4] || 0);
        return { total, idle };
    } catch {
        return null;
    }
}

function sampleCpuPercent() {
    const sample = readAggregateCpuStat();
    if (!sample) return null;

    const previous = lastCpuStatSample;
    lastCpuStatSample = sample;
    if (!previous) return null;

    const totalDiff = sample.total - previous.total;
    const idleDiff = sample.idle - previous.idle;
    if (totalDiff <= 0) return null;
    const busyRatio = Math.max(0, Math.min(1, (totalDiff - idleDiff) / totalDiff));
    return Math.round(busyRatio * 100);
}

async function getServerStatus() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const load = os.loadavg();
    const cpuCount = detectCpuCount();
    const storage = await getStorageStatus();
    const network = await getNetworkSample();
    const cpuFromProc = sampleCpuPercent();
    const fallbackPercent = Math.min(100, Math.round(((load[0] || 0) / cpuCount) * 100));
    const cpuPercent = typeof cpuFromProc === 'number' ? cpuFromProc : fallbackPercent;

    return {
        uptime: os.uptime(),
        hostname: os.hostname(),
        platform: os.platform(),
        runtime: IS_ANDROID ? 'android' : os.platform(),
        cpu: {
            cores: cpuCount,
            load1: load[0] || 0,
            load5: load[1] || 0,
            percent: cpuPercent,
            source: typeof cpuFromProc === 'number' ? 'proc-stat' : 'loadavg'
        },
        memory: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            percent: totalMem ? Math.round((usedMem / totalMem) * 100) : 0
        },
        storage,
        network
    };
}

function createId() {
    return crypto.randomBytes(16).toString('hex');
}

function createShortCode(existingVideos = []) {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const existing = new Set(existingVideos.map(video => video.shortCode).filter(Boolean));

    for (let attempt = 0; attempt < 20; attempt += 1) {
        let code = '';
        const bytes = crypto.randomBytes(8);
        for (let index = 0; index < bytes.length; index += 1) {
            code += alphabet[bytes[index] % alphabet.length];
        }

        if (!existing.has(code)) return code;
    }

    return createId().slice(0, 10);
}

function createImageCode(existingImages = []) {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const existing = new Set(existingImages.map(image => image.shortCode).filter(Boolean));

    for (let attempt = 0; attempt < 20; attempt += 1) {
        let code = '';
        const bytes = crypto.randomBytes(7);
        for (let index = 0; index < bytes.length; index += 1) {
            code += alphabet[bytes[index] % alphabet.length];
        }
        if (!existing.has(code)) return code;
    }

    return createId().slice(0, 10);
}

function sanitizeFileNamePart(value, fallback = 'FILE') {
    const cleaned = String(value || '')
        .normalize('NFKD')
        .replace(/[^\w\s@.-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || fallback;
}

async function createUniqueStoredFileName(directory, baseName, extension) {
    const safeBase = sanitizeFileNamePart(baseName).slice(0, 140);
    let candidate = `${safeBase}${extension}`;
    let counter = 2;
    while (true) {
        try {
            await fs.access(path.join(directory, candidate));
            candidate = `${safeBase} ${counter}${extension}`;
            counter += 1;
        } catch {
            return candidate;
        }
    }
}

function createAutoMediaBaseName(groupName, number) {
    return `${sanitizeFileNamePart(groupName)} @SiPalingLink ${number}`;
}

function hasAutoMediaFileName(fileName) {
    return / @SiPalingLink \d+(?: \d+)?\.[^.]+$/i.test(String(fileName || ''));
}

function getStoredUploadFileName(video) {
    return path.basename(video && (video.storedFileName || video.videoUrl || video.fileName || ''));
}

function getVideoFilePath(video) {
    return path.join(UPLOAD_DIR, getStoredUploadFileName(video));
}

function getStoredImageFileName(image) {
    return path.basename(image && (image.storedFileName || image.imageUrl || image.fileName || ''));
}

function getImageFilePath(image) {
    return path.join(IMAGE_DIR, getStoredImageFileName(image));
}

function getAllowedImageExtension(fileName, mimeType) {
    const extension = path.extname(String(fileName || '')).toLowerCase();
    const normalizedMime = String(mimeType || '').toLowerCase();
    const byMime = {
        'image/png': '.png',
        'image/jpeg': extension === '.jpeg' ? '.jpeg' : '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif'
    };
    if (byMime[normalizedMime]) return byMime[normalizedMime];
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return extension;
    return '';
}

async function detectImageExtension(filePath) {
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(12);
        const result = await handle.read(buffer, 0, 12, 0);
        const bytes = buffer.slice(0, result.bytesRead);

        if (bytes.length >= 8 && bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            return '.png';
        }
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
            return '.jpg';
        }
        if (bytes.length >= 6 && (bytes.slice(0, 6).toString('ascii') === 'GIF87a' || bytes.slice(0, 6).toString('ascii') === 'GIF89a')) {
            return '.gif';
        }
        if (bytes.length >= 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') {
            return '.webp';
        }
        return '';
    } finally {
        await handle.close();
    }
}

async function migrateFolders(folders) {
    let changed = false;
    const normalized = Array.isArray(folders) ? folders : [];

    normalized.forEach(folder => {
        if (!folder.shortCode) {
            folder.shortCode = createShortCode(normalized);
            changed = true;
        }

        if (typeof folder.isEnabled === 'undefined') {
            folder.isEnabled = true;
            changed = true;
        }
    });

    if (changed) {
        await fs.writeFile(FOLDERS_FILE, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    }

    return normalized;
}

async function migrateVideos(videos) {
    let changed = false;
    const normalized = Array.isArray(videos) ? videos : [];

    normalized.forEach(video => {
        if (!video.shortCode) {
            video.shortCode = createShortCode(normalized);
            changed = true;
        }

        if (typeof video.isEnabled === 'undefined') {
            video.isEnabled = video.isActive !== false;
            changed = true;
        }

        if (typeof video.isActive !== 'undefined') {
            delete video.isActive;
            changed = true;
        }

        if (!Array.isArray(video.adUrls) || video.adUrls.length === 0) {
            video.adUrls = video.adUrl ? [video.adUrl] : [];
            changed = true;
        }

        if (video.shortCode && video.videoUrl && !String(video.videoUrl).startsWith('/u/')) {
            const extension = path.extname(video.storedFileName || video.fileName || video.videoUrl || '') || '.mp4';
            video.videoUrl = `/u/${video.shortCode}${extension}`;
            changed = true;
        }
    });

    if (changed) {
        await fs.writeFile(DATA_FILE, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    }

    return normalized;
}

async function renameStoredMediaFile({ item, directory, desiredBaseName, extension, getFileName }) {
    const currentFileName = getFileName(item);
    if (!currentFileName || hasAutoMediaFileName(currentFileName)) {
        return false;
    }

    const currentPath = path.join(directory, currentFileName);
    try {
        await fs.access(currentPath);
    } catch {
        return false;
    }

    const targetFileName = await createUniqueStoredFileName(directory, desiredBaseName, extension || path.extname(currentFileName));
    const targetPath = path.join(directory, targetFileName);
    if (targetPath === currentPath) return false;

    await fs.rename(currentPath, targetPath);
    item.fileName = targetFileName;
    item.storedFileName = targetFileName;
    return true;
}

async function migrateExistingMediaFileNames() {
    if (mediaFileNameMigrationPromise) {
        return mediaFileNameMigrationPromise;
    }

    mediaFileNameMigrationPromise = (async () => {
        await ensureStorage();
        const [folderRaw, videoRaw, imageRaw] = await Promise.all([
            fs.readFile(FOLDERS_FILE, 'utf8'),
            fs.readFile(DATA_FILE, 'utf8'),
            fs.readFile(IMAGES_FILE, 'utf8')
        ]);
        const folders = JSON.parse(folderRaw);
        const videos = JSON.parse(videoRaw);
        const images = JSON.parse(imageRaw);
        const folderById = new Map((Array.isArray(folders) ? folders : []).map(folder => [folder.id, folder]));
        let videosChanged = false;
        let imagesChanged = false;

        const orderedVideos = (Array.isArray(videos) ? videos : [])
            .slice()
            .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const videoCounters = new Map();
        for (const video of orderedVideos) {
            const folder = video.folderId ? folderById.get(video.folderId) : null;
            const groupName = video.sourceVideoId ? 'CLIP' : (folder ? folder.title : 'VIDEO');
            const counterKey = video.sourceVideoId ? 'clip' : (video.folderId || 'single-video');
            const number = (videoCounters.get(counterKey) || 0) + 1;
            videoCounters.set(counterKey, number);
            const desiredBaseName = createAutoMediaBaseName(groupName, number);
            const extension = path.extname(getStoredUploadFileName(video)) || path.extname(video.videoUrl || '') || '.mp4';
            if (await renameStoredMediaFile({
                item: video,
                directory: UPLOAD_DIR,
                desiredBaseName,
                extension,
                getFileName: getStoredUploadFileName
            })) {
                videosChanged = true;
            }
            if (folder && video.title !== desiredBaseName) {
                video.title = desiredBaseName;
                videosChanged = true;
            }
            if (video.shortCode && !String(video.videoUrl || '').startsWith('/u/')) {
                video.videoUrl = `/u/${video.shortCode}${extension}`;
                videosChanged = true;
            }
        }

        const orderedImages = (Array.isArray(images) ? images : [])
            .slice()
            .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const imageCounters = new Map();
        for (const image of orderedImages) {
            const folder = image.folderId ? folderById.get(image.folderId) : null;
            const groupName = folder ? `${folder.title} pic` : 'FOTO';
            const counterKey = image.folderId || 'single-image';
            const number = (imageCounters.get(counterKey) || 0) + 1;
            imageCounters.set(counterKey, number);
            const desiredBaseName = createAutoMediaBaseName(groupName, number);
            const extension = path.extname(getStoredImageFileName(image)) || path.extname(image.imageUrl || '') || '.jpg';
            if (await renameStoredMediaFile({
                item: image,
                directory: IMAGE_DIR,
                desiredBaseName,
                extension,
                getFileName: getStoredImageFileName
            })) {
                imagesChanged = true;
            }
            if (folder && image.title !== desiredBaseName) {
                image.title = desiredBaseName;
                imagesChanged = true;
            }
            if (image.shortCode && !String(image.imageUrl || '').startsWith('/images/')) {
                image.imageUrl = `/images/${image.shortCode}${extension}`;
                imagesChanged = true;
            }
        }

        if (videosChanged) {
            await fs.writeFile(DATA_FILE, JSON.stringify(videos, null, 2) + '\n', 'utf8');
        }
        if (imagesChanged) {
            await fs.writeFile(IMAGES_FILE, JSON.stringify(images, null, 2) + '\n', 'utf8');
        }
    })().catch(error => {
        mediaFileNameMigrationPromise = null;
        throw error;
    });

    return mediaFileNameMigrationPromise;
}

async function readSecurityState() {
    await ensureStorage();
    try {
        const raw = await fs.readFile(SECURITY_FILE, 'utf8');
        const state = JSON.parse(raw);
        return {
            loginAttempts: state.loginAttempts || {}
        };
    } catch {
        return { loginAttempts: {} };
    }
}

async function saveSecurityState(state) {
    await ensureStorage();
    await fs.writeFile(SECURITY_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    const realIp = req.headers['x-real-ip'];
    const forwardedFor = req.headers['x-forwarded-for'];
    const forwardedIp = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : String(forwardedFor || '').split(',')[0].trim();

    return String(cfIp || realIp || forwardedIp || req.socket.remoteAddress || 'unknown');
}

function isPrivateIp(ip) {
    return ip === 'unknown'
        || ip === '::1'
        || ip.startsWith('::ffff:127.')
        || ip.startsWith('127.')
        || ip.startsWith('10.')
        || ip.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

function requestJson(url) {
    return new Promise(resolve => {
        const client = url.startsWith('https:') ? require('https') : require('http');
        const req = client.get(url, { timeout: 2500 }, res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
        req.on('error', () => resolve(null));
    });
}

function runFfmpegClip({ inputPath, outputPath, start, duration }) {
    return new Promise((resolve, reject) => {
        const args = [
            '-y',
            '-ss', String(start),
            '-i', inputPath,
            '-t', String(duration),
            '-map', '0:v:0',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            outputPath
        ];
        const child = childProcess.spawn('ffmpeg', args, { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', error => {
            reject(new Error(error.code === 'ENOENT'
                ? 'ffmpeg belum terinstall di server.'
                : error.message));
        });
        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || 'Potong video gagal.'));
        });
    });
}

function runFfmpegThumbnail({ inputPath, outputPath }) {
    return new Promise((resolve, reject) => {
        const args = [
            '-y',
            '-ss', '1',
            '-i', inputPath,
            '-frames:v', '1',
            '-vf', 'scale=360:-1',
            '-q:v', '5',
            outputPath
        ];
        const child = childProcess.spawn('ffmpeg', args, { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', error => {
            reject(new Error(error.code === 'ENOENT'
                ? 'ffmpeg belum terinstall di server.'
                : error.message));
        });
        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || 'Thumbnail video gagal dibuat.'));
        });
    });
}

function getCompressionThreadCount() {
    const cores = Math.max(1, detectCpuCount());
    const target = Math.max(1, Math.floor((cores * COMPRESS_CPU_PERCENT) / 100));
    return Math.min(cores, target);
}

function spawnFfmpeg(args, { onStderr } = {}) {
    const useNice = (process.platform === 'linux' || IS_ANDROID) && COMPRESS_NICENESS > 0;
    let command = 'ffmpeg';
    let finalArgs = args;
    if (useNice) {
        command = 'nice';
        finalArgs = ['-n', String(COMPRESS_NICENESS), 'ffmpeg', ...args];
    }
    const child = childProcess.spawn(command, finalArgs, { windowsHide: true });
    if (child.stderr && onStderr) {
        child.stderr.on('data', chunk => onStderr(chunk.toString()));
    }
    return child;
}

function runFfmpegCompress({ inputPath, outputPath, onProgress, onDuration }) {
    return new Promise((resolve, reject) => {
        const threads = getCompressionThreadCount();
        const args = [
            '-y',
            '-i', inputPath,
            '-c:v', 'libx264',
            '-preset', COMPRESS_PRESET,
            '-crf', COMPRESS_CRF,
            '-pix_fmt', 'yuv420p',
            '-profile:v', 'high',
            '-level', '4.0',
            '-c:a', 'aac',
            '-b:a', COMPRESS_AUDIO_BITRATE,
            '-threads', String(threads),
            '-movflags', '+faststart',
            outputPath
        ];

        let stderr = '';
        let detectedDuration = 0;

        const child = spawnFfmpeg(args, {
            onStderr: text => {
                stderr += text;
                if (!detectedDuration) {
                    const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                    if (durationMatch) {
                        detectedDuration = Number(durationMatch[1]) * 3600
                            + Number(durationMatch[2]) * 60
                            + Number(durationMatch[3]);
                        if (onDuration) onDuration(detectedDuration);
                    }
                }
                const timeMatch = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
                if (timeMatch && onProgress) {
                    const seconds = Number(timeMatch[1]) * 3600
                        + Number(timeMatch[2]) * 60
                        + Number(timeMatch[3]);
                    onProgress(seconds, detectedDuration);
                }
            }
        });

        child.on('error', error => {
            reject(new Error(error.code === 'ENOENT'
                ? 'ffmpeg belum terinstall di server.'
                : error.message));
        });
        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || 'Kompresi video gagal.'));
        });
    });
}

async function updateVideoFields(videoId, patch) {
    const videos = await readVideos();
    const target = videos.find(item => item.id === videoId);
    if (!target) return null;
    Object.assign(target, patch);
    await saveVideos(videos);
    return target;
}

async function compressVideoFile(video, { force = false } = {}) {
    if (!video || !video.id) return { status: 'skipped', reason: 'no_video' };

    const filePath = getVideoFilePath(video);
    let originalStat;
    try {
        originalStat = await fs.stat(filePath);
    } catch {
        await updateVideoFields(video.id, {
            compressionStatus: 'failed',
            compressionError: 'File tidak ditemukan saat kompresi.',
            compressionUpdatedAt: new Date().toISOString()
        });
        return { status: 'failed', reason: 'file_missing' };
    }

    if (!force && originalStat.size < COMPRESS_MIN_BYTES) {
        await updateVideoFields(video.id, {
            compressionStatus: 'skipped',
            compressionReason: 'under_threshold',
            originalSize: originalStat.size,
            compressionUpdatedAt: new Date().toISOString()
        });
        return { status: 'skipped', reason: 'under_threshold' };
    }

    const tempPath = `${filePath}.compressing.mp4`;

    await updateVideoFields(video.id, {
        compressionStatus: 'compressing',
        compressionStartedAt: new Date().toISOString(),
        originalSize: originalStat.size,
        compressionError: null,
        compressionUpdatedAt: new Date().toISOString()
    });

    compressionState.current = {
        id: video.id,
        title: video.title,
        startedAt: Date.now(),
        durationSeconds: 0,
        processedSeconds: 0,
        progress: 0,
        originalSize: originalStat.size
    };

    try {
        await runFfmpegCompress({
            inputPath: filePath,
            outputPath: tempPath,
            onDuration: duration => {
                if (compressionState.current && compressionState.current.id === video.id) {
                    compressionState.current.durationSeconds = duration;
                }
            },
            onProgress: (seconds, duration) => {
                if (compressionState.current && compressionState.current.id === video.id) {
                    compressionState.current.processedSeconds = seconds;
                    if (duration > 0) {
                        compressionState.current.durationSeconds = duration;
                        compressionState.current.progress = Math.min(99, Math.round((seconds / duration) * 100));
                    }
                }
            }
        });
    } catch (error) {
        await removeFile(tempPath);
        await updateVideoFields(video.id, {
            compressionStatus: 'failed',
            compressionError: error.message || 'Kompresi gagal.',
            compressionUpdatedAt: new Date().toISOString()
        });
        compressionState.history.unshift({
            id: video.id,
            title: video.title,
            status: 'failed',
            error: error.message || 'Kompresi gagal.',
            finishedAt: Date.now()
        });
        compressionState.history = compressionState.history.slice(0, 30);
        compressionState.current = null;
        throw error;
    }

    let newStat;
    try {
        newStat = await fs.stat(tempPath);
    } catch (error) {
        await removeFile(tempPath);
        await updateVideoFields(video.id, {
            compressionStatus: 'failed',
            compressionError: 'Output kompresi tidak ditemukan.',
            compressionUpdatedAt: new Date().toISOString()
        });
        compressionState.current = null;
        throw error;
    }

    const minAcceptable = Math.floor(originalStat.size * (1 - COMPRESS_MIN_SAVING_RATIO));
    if (newStat.size >= minAcceptable) {
        await removeFile(tempPath);
        await updateVideoFields(video.id, {
            compressionStatus: 'skipped',
            compressionReason: 'no_savings',
            originalSize: originalStat.size,
            compressedSize: newStat.size,
            compressionUpdatedAt: new Date().toISOString()
        });
        compressionState.history.unshift({
            id: video.id,
            title: video.title,
            status: 'skipped',
            reason: 'no_savings',
            originalSize: originalStat.size,
            compressedSize: newStat.size,
            finishedAt: Date.now()
        });
        compressionState.history = compressionState.history.slice(0, 30);
        compressionState.current = null;
        return { status: 'skipped', reason: 'no_savings', originalSize: originalStat.size, compressedSize: newStat.size };
    }

    await fs.rename(tempPath, filePath);
    await updateVideoFields(video.id, {
        compressionStatus: 'done',
        originalSize: originalStat.size,
        compressedSize: newStat.size,
        compressionRatio: originalStat.size ? Number((newStat.size / originalStat.size).toFixed(3)) : null,
        compressionFinishedAt: new Date().toISOString(),
        compressionError: null,
        compressionUpdatedAt: new Date().toISOString()
    });

    try {
        const thumbPath = path.join(THUMB_DIR, `${video.id}.jpg`);
        await removeFile(thumbPath);
    } catch {
        // ignore
    }
    ensureVideoThumbnail({ ...video }, { force: true }).catch(() => {});

    compressionState.history.unshift({
        id: video.id,
        title: video.title,
        status: 'done',
        originalSize: originalStat.size,
        compressedSize: newStat.size,
        finishedAt: Date.now()
    });
    compressionState.history = compressionState.history.slice(0, 30);
    compressionState.current = null;

    return {
        status: 'done',
        originalSize: originalStat.size,
        compressedSize: newStat.size
    };
}

function getCompressionSnapshot() {
    return {
        cpuPercent: COMPRESS_CPU_PERCENT,
        threads: getCompressionThreadCount(),
        thresholdBytes: COMPRESS_MIN_BYTES,
        crf: COMPRESS_CRF,
        preset: COMPRESS_PRESET,
        current: compressionState.current ? { ...compressionState.current } : null,
        queue: compressionState.queue.map(item => ({ ...item })),
        history: compressionState.history.slice(0, 15).map(item => ({ ...item }))
    };
}

function getRestoreSnapshot() {
    return {
        current: restoreState.current ? { ...restoreState.current } : null,
        queue: restoreState.queue.map(item => ({ ...item })),
        history: restoreState.history.slice(0, 20).map(item => ({ ...item }))
    };
}

async function performRestore(record, { force = false } = {}) {
    const videoSnapshot = record.videoSnapshot;
    if (!videoSnapshot || !videoSnapshot.id) return { status: 'skipped', reason: 'no_snapshot' };
    if (!record.telegram || !record.telegram.messageId) return { status: 'skipped', reason: 'no_telegram' };

    const filePath = getVideoFilePath(videoSnapshot);

    if (!force) {
        try {
            const existing = await fs.stat(filePath);
            if (existing && existing.isFile() && existing.size > 0) {
                restoreState.history.unshift({
                    id: videoSnapshot.id,
                    title: videoSnapshot.title || videoSnapshot.id,
                    status: 'skipped',
                    reason: 'already_exists',
                    size: existing.size,
                    finishedAt: Date.now()
                });
                restoreState.history = restoreState.history.slice(0, 30);
                await updateBackupRecord(videoSnapshot.id, {
                    status: 'restored',
                    restoreSkippedAt: new Date().toISOString(),
                    restoreReason: 'already_exists'
                }).catch(() => {});
                return { status: 'skipped', reason: 'already_exists', filePath };
            }
        } catch {
            // file tidak ada, lanjut download
        }
    }

    restoreState.current = {
        id: videoSnapshot.id,
        title: videoSnapshot.title || videoSnapshot.id,
        startedAt: Date.now(),
        receivedBytes: 0,
        totalBytes: 0,
        progress: 0
    };
    await updateBackupRecord(videoSnapshot.id, {
        status: 'restoring',
        restoreStartedAt: new Date().toISOString()
    }).catch(() => {});

    try {
        await telegramBackup.restoreVideoBackup({
            backup: record.telegram,
            outputPath: filePath,
            onProgress: (received, total) => {
                if (!restoreState.current || restoreState.current.id !== videoSnapshot.id) return;
                restoreState.current.receivedBytes = received;
                if (total > 0) {
                    restoreState.current.totalBytes = total;
                    restoreState.current.progress = Math.min(99, Math.round((received / total) * 100));
                }
            }
        });
    } catch (error) {
        restoreState.history.unshift({
            id: videoSnapshot.id,
            title: videoSnapshot.title || videoSnapshot.id,
            status: 'failed',
            error: error.message || 'Restore Telegram gagal.',
            finishedAt: Date.now()
        });
        restoreState.history = restoreState.history.slice(0, 30);
        restoreState.current = null;
        await updateBackupRecord(videoSnapshot.id, {
            status: 'restore_failed',
            error: error.message || 'Restore Telegram gagal.'
        }).catch(() => {});
        throw error;
    }

    const folders = await readFolders();
    if (record.folderSnapshot && !folders.some(folder => folder.id === record.folderSnapshot.id)) {
        folders.unshift(record.folderSnapshot);
        await saveFolders(folders);
    }

    const videos = await readVideos();
    const existingIndex = videos.findIndex(video => video.id === videoSnapshot.id);
    if (existingIndex >= 0) {
        videos[existingIndex] = { ...videos[existingIndex], ...videoSnapshot };
    } else {
        videos.unshift(videoSnapshot);
    }
    await saveVideos(videos);
    await updateBackupRecord(videoSnapshot.id, {
        status: 'restored',
        restoredAt: new Date().toISOString()
    }).catch(() => {});

    let finalSize = 0;
    try {
        const stat = await fs.stat(filePath);
        finalSize = stat.size;
    } catch {
        // ignore
    }

    restoreState.history.unshift({
        id: videoSnapshot.id,
        title: videoSnapshot.title || videoSnapshot.id,
        status: 'done',
        size: finalSize,
        finishedAt: Date.now()
    });
    restoreState.history = restoreState.history.slice(0, 30);
    restoreState.current = null;

    return { status: 'done', filePath };
}

function enqueueRestore(record, { force = false } = {}) {
    if (!record || !record.videoSnapshot || !record.videoSnapshot.id) {
        return Promise.resolve({ status: 'skipped', reason: 'no_video' });
    }
    const id = record.videoSnapshot.id;
    if (videoRestorePending.has(id)) {
        return Promise.resolve({ status: 'already_queued' });
    }

    videoRestorePending.add(id);
    restoreState.queue.push({
        id,
        title: record.videoSnapshot.title || id,
        queuedAt: Date.now(),
        force
    });

    const queued = videoRestoreQueue.then(async () => {
        restoreState.queue = restoreState.queue.filter(item => item.id !== id);
        return performRestore(record, { force });
    });

    videoRestoreQueue = queued.catch(error => {
        console.error('[restore]', id, error.message || error);
    }).finally(() => {
        videoRestorePending.delete(id);
        restoreState.queue = restoreState.queue.filter(item => item.id !== id);
        if (restoreState.current && restoreState.current.id === id) {
            restoreState.current = null;
        }
    });

    return queued;
}

function enqueueVideoCompression(video, { force = false } = {}) {
    if (!video || !video.id) return Promise.resolve(null);
    if (videoCompressionPending.has(video.id)) {
        return Promise.resolve({ status: 'already_queued' });
    }

    videoCompressionPending.add(video.id);
    compressionState.queue.push({
        id: video.id,
        title: video.title,
        force,
        queuedAt: Date.now()
    });

    const queued = videoCompressionQueue.then(async () => {
        compressionState.queue = compressionState.queue.filter(item => item.id !== video.id);
        const videos = await readVideos();
        const latest = videos.find(item => item.id === video.id) || video;
        if (!force && latest && latest.compressionStatus === 'done') {
            return { status: 'skipped', reason: 'already_done' };
        }
        return compressVideoFile(latest, { force });
    });

    videoCompressionQueue = queued.catch(error => {
        console.error('[compress]', video.id, error.message || error);
    }).finally(() => {
        videoCompressionPending.delete(video.id);
        compressionState.queue = compressionState.queue.filter(item => item.id !== video.id);
        if (compressionState.current && compressionState.current.id === video.id) {
            compressionState.current = null;
        }
    });

    return queued;
}

async function scheduleVideoCompressionIfNeeded(video) {
    if (!video || !video.id) return null;
    try {
        const filePath = getVideoFilePath(video);
        const stat = await fs.stat(filePath);
        if (stat.size >= COMPRESS_MIN_BYTES) {
            await updateVideoFields(video.id, {
                compressionStatus: 'queued',
                originalSize: stat.size,
                compressionUpdatedAt: new Date().toISOString()
            });
            return enqueueVideoCompression(video);
        }
        await updateVideoFields(video.id, {
            compressionStatus: 'skipped',
            compressionReason: 'under_threshold',
            originalSize: stat.size,
            compressionUpdatedAt: new Date().toISOString()
        });
        return null;
    } catch {
        return null;
    }
}

async function backfillVideoCompression() {
    try {
        const videos = await readVideos();
        for (const video of videos) {
            if (!video || !video.id) continue;
            if (['done', 'compressing', 'queued'].includes(video.compressionStatus)) continue;
            if (video.compressionStatus === 'skipped' && video.compressionReason === 'no_savings') continue;
            try {
                const filePath = getVideoFilePath(video);
                const stat = await fs.stat(filePath);
                if (stat.size < COMPRESS_MIN_BYTES) continue;
                await scheduleVideoCompressionIfNeeded(video);
            } catch {
                // missing file
            }
        }
    } catch {
        // ignore
    }
}

function ensureVideoThumbnail(video, { force = false } = {}) {
    if (!video || !video.id) return Promise.resolve(null);
    if (thumbnailGenerations.has(video.id)) {
        return thumbnailGenerations.get(video.id);
    }

    const thumbPath = path.join(THUMB_DIR, `${video.id}.jpg`);
    const inputPath = getVideoFilePath(video);

    const job = (async () => {
        if (!force) {
            try {
                const stat = await fs.stat(thumbPath);
                if (stat.size > 0) return thumbPath;
            } catch {
                // Need to generate.
            }
        }

        try {
            await fs.access(inputPath);
        } catch {
            return null;
        }

        await fs.mkdir(THUMB_DIR, { recursive: true });
        await runFfmpegThumbnail({ inputPath, outputPath: thumbPath });
        return thumbPath;
    })().catch(error => {
        console.error('[thumbnail]', video.id, error.message || error);
        return null;
    }).finally(() => {
        thumbnailGenerations.delete(video.id);
    });

    thumbnailGenerations.set(video.id, job);
    return job;
}

function requestTelegramBotMultipart(botToken, method, fields = {}, files = []) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const boundary = `----webaff${crypto.randomBytes(12).toString('hex')}`;
        const chunks = [];

        Object.entries(fields).forEach(([key, value]) => {
            if (typeof value === 'undefined' || value === null || value === '') return;
            chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`));
        });

        const fileParts = files.map(file => ({
            file,
            head: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\nContent-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`),
            tail: Buffer.from('\r\n'),
            size: fsNative.statSync(file.filePath).size
        }));

        const closing = Buffer.from(`--${boundary}--\r\n`);
        const contentLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
            + fileParts.reduce((sum, part) => sum + part.head.length + part.size + part.tail.length, 0)
            + closing.length;
        const req = https.request({
            method: 'POST',
            hostname: 'api.telegram.org',
            path: `/bot${botToken}/${method}`,
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': contentLength
            },
            timeout: 120000
        }, res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                let data = null;
                try {
                    data = JSON.parse(raw);
                } catch {
                    data = { ok: false, description: raw || 'Telegram response tidak valid.' };
                }
                if (!data.ok) {
                    reject(new Error(data.description || 'Telegram Bot API gagal.'));
                    return;
                }
                resolve(data);
            });
        });
        req.on('timeout', () => req.destroy(new Error('Telegram Bot API timeout.')));
        req.on('error', reject);
        chunks.forEach(chunk => req.write(chunk));
        if (!fileParts.length) {
            req.end(closing);
            return;
        }

        let index = 0;
        const writeNextFile = () => {
            const part = fileParts[index];
            if (!part) {
                req.end(closing);
                return;
            }
            req.write(part.head);
            const stream = fsNative.createReadStream(part.file.filePath);
            stream.on('error', reject);
            stream.on('end', () => {
                req.write(part.tail);
                index += 1;
                writeNextFile();
            });
            stream.pipe(req, { end: false });
        };
        writeNextFile();
    });
}

function requestTelegramBotJson(botToken, method, fields = {}, file = null) {
    return requestTelegramBotMultipart(botToken, method, fields, file ? [file] : []);
}

async function lookupGeoIp(ip) {
    if (isPrivateIp(ip)) {
        return {
            country: 'Local/Private',
            region: '',
            city: '',
            lat: null,
            lon: null,
            isp: '',
            org: ''
        };
    }

    const endpoint = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,lat,lon,isp,org,query`;
    const data = await requestJson(endpoint);
    if (!data || data.status !== 'success') {
        return {
            country: '',
            region: '',
            city: '',
            lat: null,
            lon: null,
            isp: '',
            org: ''
        };
    }

    return {
        country: data.country || '',
        region: data.regionName || '',
        city: data.city || '',
        lat: typeof data.lat === 'number' ? data.lat : null,
        lon: typeof data.lon === 'number' ? data.lon : null,
        isp: data.isp || '',
        org: data.org || ''
    };
}

async function recordVisitor(req, details = {}) {
    const ip = getClientIp(req);
    const visitors = await readVisitors();
    const existing = visitors.find(visitor => visitor.ip === ip && visitor.geo);
    const geo = existing && existing.geo ? existing.geo : await lookupGeoIp(ip);
    const now = new Date().toISOString();

    visitors.unshift({
        id: createId(),
        ip,
        type: details.type || 'page',
        targetId: details.targetId || null,
        targetTitle: details.targetTitle || '',
        path: details.path || '',
        userAgent: req.headers['user-agent'] || '',
        referer: req.headers.referer || '',
        geo,
        createdAt: now
    });

    await saveVisitors(visitors);
}

async function getLoginLock(req) {
    const ip = getClientIp(req);
    const state = await readSecurityState();
    const record = state.loginAttempts[ip];

    if (!record || !record.lockedUntil) {
        return { ip, state, locked: false, remainingMs: 0 };
    }

    const remainingMs = Number(record.lockedUntil) - Date.now();
    if (remainingMs <= 0) {
        delete state.loginAttempts[ip];
        await saveSecurityState(state);
        return { ip, state, locked: false, remainingMs: 0 };
    }

    return { ip, state, locked: true, remainingMs };
}

async function recordFailedLogin(ip, state) {
    const record = state.loginAttempts[ip] || { count: 0, lockedUntil: null };
    record.count += 1;
    record.lastFailedAt = new Date().toISOString();

    if (record.count >= MAX_LOGIN_ATTEMPTS) {
        record.lockedUntil = Date.now() + LOCKOUT_MS;
    }

    state.loginAttempts[ip] = record;
    await saveSecurityState(state);
    return record;
}

async function clearFailedLogin(ip, state) {
    if (state.loginAttempts[ip]) {
        delete state.loginAttempts[ip];
        await saveSecurityState(state);
    }
}

async function removeFile(filePath) {
    try {
        await fs.unlink(filePath);
    } catch {
        // File already gone; nothing to clean.
    }
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function sendError(res, statusCode, message) {
    sendJson(res, statusCode, { error: message });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_JSON_BYTES) {
                reject(new Error('Payload terlalu besar.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function readJson(req) {
    const raw = await readBody(req);
    if (!raw) return {};
    return JSON.parse(raw);
}

function getBearerToken(req) {
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : '';
}

function requireAdmin(req, res) {
    const token = getBearerToken(req);
    if (!token || !sessions.has(token)) {
        sendError(res, 401, 'Unauthorized');
        return false;
    }
    return true;
}

function sanitizeVideo(video) {
    return {
        id: video.id,
        folderId: video.folderId || null,
        title: video.title,
        videoUrl: video.videoUrl,
        shortCode: video.shortCode,
        fileName: video.fileName,
        adUrl: video.adUrl,
        adUrls: Array.isArray(video.adUrls) ? video.adUrls : (video.adUrl ? [video.adUrl] : []),
        requiredClicks: video.requiredClicks,
        views: video.views || 0,
        clicks: video.clicks || 0,
        isEnabled: video.isEnabled !== false,
        createdAt: video.createdAt,
        compressionStatus: video.compressionStatus || 'idle',
        compressionReason: video.compressionReason || null,
        compressionError: video.compressionError || null,
        originalSize: video.originalSize || null,
        compressedSize: video.compressedSize || null,
        compressionRatio: typeof video.compressionRatio === 'number' ? video.compressionRatio : null,
        compressionUpdatedAt: video.compressionUpdatedAt || null
    };
}

function sanitizeFolder(folder, videos = []) {
    const folderVideos = videos.filter(video => video.folderId === folder.id);
    return {
        id: folder.id,
        title: folder.title,
        shortCode: folder.shortCode,
        isEnabled: folder.isEnabled !== false,
        videoCount: folderVideos.length,
        views: folderVideos.reduce((sum, video) => sum + Number(video.views || 0), 0),
        clicks: folderVideos.reduce((sum, video) => sum + Number(video.clicks || 0), 0),
        createdAt: folder.createdAt
    };
}

function sanitizeLinkItem(item) {
    return {
        id: item.id,
        label: item.label || '',
        url: item.url,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt || null
    };
}

function sanitizeImage(image) {
    return {
        id: image.id,
        folderId: image.folderId || null,
        shortCode: image.shortCode,
        title: image.title,
        fileName: image.fileName,
        imageUrl: image.imageUrl,
        adUrl: image.adUrl || '',
        adUrls: Array.isArray(image.adUrls) ? image.adUrls : (image.adUrl ? [image.adUrl] : []),
        requiredClicks: image.requiredClicks || 1,
        mimeType: image.mimeType,
        size: image.size || 0,
        createdAt: image.createdAt
    };
}

function getExtension(fileName, mimeType) {
    const fromName = path.extname(fileName || '').toLowerCase();
    if (['.mp4', '.webm', '.ogg', '.mov', '.m4v'].includes(fromName)) {
        return fromName;
    }

    const fromMime = {
        'video/mp4': '.mp4',
        'video/webm': '.webm',
        'video/ogg': '.ogg',
        'video/quicktime': '.mov'
    };

    return fromMime[mimeType] || '.mp4';
}

function parseDataUrl(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;,]+)?;base64,(.+)$/);
    if (!match) return null;
    return {
        mimeType: match[1] || 'application/octet-stream',
        buffer: Buffer.from(match[2], 'base64')
    };
}

async function handleApi(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
        const lock = await getLoginLock(req);
        if (lock.locked) {
            const hours = Math.ceil(lock.remainingMs / (60 * 60 * 1000));
            sendJson(res, 429, {
                error: `Terlalu banyak percobaan salah. IP diblokir sekitar ${hours} jam.`,
                lockedUntil: new Date(Date.now() + lock.remainingMs).toISOString()
            });
            return;
        }

        const body = await readJson(req);
        if (body.pin !== ADMIN_PIN) {
            const record = await recordFailedLogin(lock.ip, lock.state);
            if (record.lockedUntil) {
                sendJson(res, 429, {
                    error: 'PIN salah 3 kali. IP diblokir selama 24 jam.',
                    lockedUntil: new Date(record.lockedUntil).toISOString()
                });
                return;
            }

            sendJson(res, 401, {
                error: `PIN salah. Sisa percobaan: ${MAX_LOGIN_ATTEMPTS - record.count}.`
            });
            return;
        }

        await clearFailedLogin(lock.ip, lock.state);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { createdAt: Date.now() });
        sendJson(res, 200, { token });
        return;
    }

    if (url.pathname.startsWith('/api/admin')) {
        if (!requireAdmin(req, res)) return;

        if (req.method === 'GET' && url.pathname === '/api/admin/videos') {
            await migrateExistingMediaFileNames();
            const videos = await readVideos();
            sendJson(res, 200, { videos: videos.map(sanitizeVideo) });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/folders') {
            await migrateExistingMediaFileNames();
            const folders = await readFolders();
            const videos = await readVideos();
            sendJson(res, 200, { folders: folders.map(folder => sanitizeFolder(folder, videos)) });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/link-bank') {
            const links = await readLinkBank();
            sendJson(res, 200, { links: links.map(sanitizeLinkItem) });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/images') {
            await migrateExistingMediaFileNames();
            const images = await readImages();
            sendJson(res, 200, { images: images.map(sanitizeImage) });
            return;
        }

        const imageMatch = url.pathname.match(/^\/api\/admin\/images\/([^/]+)$/);
        if (imageMatch && req.method === 'DELETE') {
            const images = await readImages();
            const image = images.find(item => item.id === imageMatch[1] || item.shortCode === imageMatch[1]);
            if (!image) {
                sendError(res, 404, 'Image tidak ditemukan.');
                return;
            }

            const nextImages = images.filter(item => item.id !== image.id);
            await saveImages(nextImages);
            await removeFile(getImageFilePath(image));
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/visitors') {
            const visitors = await readVisitors();
            sendJson(res, 200, { visitors: visitors.slice(0, 500) });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/server-status') {
            sendJson(res, 200, { status: await getServerStatus() });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/compression-queue') {
            sendJson(res, 200, { compression: getCompressionSnapshot() });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/restore-queue') {
            sendJson(res, 200, { restore: getRestoreSnapshot() });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/network-debug') {
            const counters = await readNetworkCounters();
            const sample = await getNetworkSample();
            const probes = {};
            try {
                const procContent = await fs.readFile('/proc/net/dev', 'utf8');
                probes.procNetDev = 'accessible';
                probes.procNetDevContent = procContent.slice(0, 2000);
                probes.procNetDevLines = procContent.split(/\r?\n/).length;
            } catch (error) {
                probes.procNetDev = `error: ${error.code || error.message}`;
            }
            try {
                const list = await fs.readdir('/sys/class/net');
                probes.sysClassNet = list.join(', ');
                for (const iface of list.slice(0, 6)) {
                    try {
                        const rx = await fs.readFile(`/sys/class/net/${iface}/statistics/rx_bytes`, 'utf8');
                        const tx = await fs.readFile(`/sys/class/net/${iface}/statistics/tx_bytes`, 'utf8');
                        probes[`sysfs_${iface}`] = `rx=${rx.trim()} tx=${tx.trim()}`;
                    } catch (error) {
                        probes[`sysfs_${iface}`] = `error: ${error.code || error.message}`;
                    }
                }
            } catch (error) {
                probes.sysClassNet = `error: ${error.code || error.message}`;
            }
            try {
                const ipOut = await execCommand('ip -s -o link');
                probes.ipLink = ipOut ? `len=${ipOut.length}` : 'empty';
                if (ipOut) probes.ipLinkSample = ipOut.slice(0, 1500);
            } catch (error) {
                probes.ipLink = `error: ${error.message}`;
            }
            try {
                const ifconfigOut = await execCommand('ifconfig 2>&1');
                probes.ifconfig = ifconfigOut ? `len=${ifconfigOut.length}` : 'empty';
                if (ifconfigOut) probes.ifconfigSample = ifconfigOut.slice(0, 1500);
            } catch (error) {
                probes.ifconfig = `error: ${error.message}`;
            }
            sendJson(res, 200, { counters, sample, probes });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/telegram-backups') {
            sendJson(res, 200, {
                telegram: telegramBackup.getStatus(),
                backups: await readTelegramBackups()
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/telegram-bot') {
            const config = await readTelegramBotConfig();
            sendJson(res, 200, { bot: sanitizeTelegramBotConfig(config) });
            return;
        }

        if (req.method === 'PUT' && url.pathname === '/api/admin/telegram-bot') {
            const body = await readJson(req);
            const current = await readTelegramBotConfig();
            const botToken = String(body.botToken || '').trim() || current.botToken;
            const chatId = String(body.chatId || '').trim();
            if (!botToken) {
                sendError(res, 400, 'Token bot wajib diisi saat setup pertama.');
                return;
            }
            if (!chatId) {
                sendError(res, 400, 'Chat ID atau username grup wajib diisi.');
                return;
            }
            await saveTelegramBotConfig({ botToken, chatId });
            sendJson(res, 200, { bot: sanitizeTelegramBotConfig({ botToken, chatId }) });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/telegram-bot/send') {
            const body = await readJson(req);
            const config = await readTelegramBotConfig();
            if (!config.botToken || !config.chatId) {
                sendError(res, 400, 'Token bot dan chat ID belum disetting.');
                return;
            }

            const chatId = String(body.chatId || config.chatId).trim();
            const description = String(body.description || '').trim();
            const videoIds = Array.isArray(body.videoIds) ? body.videoIds.map(String) : [];
            const imageIds = Array.isArray(body.imageIds) ? body.imageIds.map(String) : [];
            const videos = await readVideos();
            const images = await readImages();
            const sent = [];
            const mediaItems = [];

            if (!videoIds.length && !imageIds.length && description) {
                const result = await requestTelegramBotJson(config.botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: description
                });
                sent.push(result.result && result.result.message_id);
            }

            for (const imageId of imageIds) {
                const image = images.find(item => item.id === imageId || item.shortCode === imageId);
                if (!image) continue;
                const filePath = getImageFilePath(image);
                mediaItems.push({
                    kind: 'photo',
                    fieldName: 'photo',
                    fileName: image.fileName || image.storedFileName || 'image.jpg',
                    contentType: image.mimeType || 'image/jpeg',
                    filePath
                });
            }

            for (const videoId of videoIds) {
                const video = videos.find(item => item.id === videoId || item.shortCode === videoId);
                if (!video) continue;
                const filePath = getVideoFilePath(video);
                mediaItems.push({
                    kind: 'video',
                    fieldName: 'video',
                    fileName: video.fileName || path.basename(filePath),
                    contentType: contentTypes[path.extname(filePath).toLowerCase()] || 'video/mp4',
                    filePath
                });
            }

            for (let offset = 0; offset < mediaItems.length; offset += 10) {
                const batch = mediaItems.slice(offset, offset + 10);
                if (batch.length === 1) {
                    const media = batch[0];
                    const result = await requestTelegramBotJson(config.botToken, media.kind === 'photo' ? 'sendPhoto' : 'sendVideo', {
                        chat_id: chatId,
                        caption: offset === 0 ? description : '',
                        supports_streaming: media.kind === 'video' ? 'true' : undefined
                    }, {
                        fieldName: media.kind === 'photo' ? 'photo' : 'video',
                        fileName: media.fileName,
                        contentType: media.contentType,
                        filePath: media.filePath
                    });
                    sent.push(result.result && result.result.message_id);
                    continue;
                }

                const files = batch.map((media, index) => ({
                    fieldName: `file${offset + index}`,
                    fileName: media.fileName,
                    contentType: media.contentType,
                    filePath: media.filePath
                }));
                const mediaPayload = batch.map((media, index) => ({
                    type: media.kind,
                    media: `attach://file${offset + index}`,
                    caption: offset === 0 && index === 0 ? description : undefined,
                    supports_streaming: media.kind === 'video' ? true : undefined
                }));
                const result = await requestTelegramBotMultipart(config.botToken, 'sendMediaGroup', {
                    chat_id: chatId,
                    media: JSON.stringify(mediaPayload)
                }, files);
                const messages = Array.isArray(result.result) ? result.result : [];
                messages.forEach(message => sent.push(message && message.message_id));
            }

            sendJson(res, 200, { ok: true, sent: sent.filter(Boolean) });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/link-bank') {
            const body = await readJson(req);
            if (Array.isArray(body.links)) {
                const links = await readLinkBank();
                const created = body.links
                    .map(item => ({
                        label: String(item.label || '').trim(),
                        url: String(item.url || '').trim()
                    }))
                    .filter(item => item.url)
                    .map(item => ({
                        id: createId(),
                        label: item.label,
                        url: item.url,
                        createdAt: new Date().toISOString(),
                        updatedAt: null
                    }));

                if (!created.length) {
                    sendError(res, 400, 'Tidak ada URL valid untuk disimpan.');
                    return;
                }

                await saveLinkBank([...created, ...links]);
                sendJson(res, 201, { links: created.map(sanitizeLinkItem) });
                return;
            }

            const urlValue = String(body.url || '').trim();
            const label = String(body.label || '').trim();
            if (!urlValue) {
                sendError(res, 400, 'URL wajib diisi.');
                return;
            }

            const links = await readLinkBank();
            const item = {
                id: createId(),
                label,
                url: urlValue,
                createdAt: new Date().toISOString(),
                updatedAt: null
            };
            links.unshift(item);
            await saveLinkBank(links);
            sendJson(res, 201, { link: sanitizeLinkItem(item) });
            return;
        }

        const linkBankMatch = url.pathname.match(/^\/api\/admin\/link-bank\/([^/]+)$/);
        if (linkBankMatch && req.method === 'PUT') {
            const body = await readJson(req);
            const links = await readLinkBank();
            const item = links.find(link => link.id === linkBankMatch[1]);
            if (!item) {
                sendError(res, 404, 'Link tidak ditemukan.');
                return;
            }

            const urlValue = String(body.url || '').trim();
            if (!urlValue) {
                sendError(res, 400, 'URL wajib diisi.');
                return;
            }

            item.url = urlValue;
            item.label = String(body.label || '').trim();
            item.updatedAt = new Date().toISOString();
            await saveLinkBank(links);
            sendJson(res, 200, { link: sanitizeLinkItem(item) });
            return;
        }

        if (linkBankMatch && req.method === 'DELETE') {
            const links = await readLinkBank();
            const nextLinks = links.filter(link => link.id !== linkBankMatch[1]);
            if (nextLinks.length === links.length) {
                sendError(res, 404, 'Link tidak ditemukan.');
                return;
            }
            await saveLinkBank(nextLinks);
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/folders') {
            const body = await readJson(req);
            const title = String(body.title || '').trim();
            if (!title) {
                sendError(res, 400, 'Judul folder wajib diisi.');
                return;
            }

            const folders = await readFolders();
            const folder = {
                id: createId(),
                shortCode: createShortCode(folders),
                title,
                isEnabled: true,
                createdAt: new Date().toISOString()
            };

            folders.unshift(folder);
            await saveFolders(folders);
            sendJson(res, 201, { folder: sanitizeFolder(folder, []) });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/uploads/start') {
            const body = await readJson(req);
            const fileName = String(body.fileName || 'video.mp4').trim();
            const mimeType = String(body.mimeType || 'video/mp4').trim();
            const totalSize = Number(body.totalSize || 0);
            const uploadType = body.uploadType === 'image' ? 'image' : 'video';

            if (!totalSize) {
                sendError(res, 400, 'Ukuran file tidak valid.');
                return;
            }

            if (uploadType === 'video' && !mimeType.startsWith('video/')) {
                sendError(res, 400, 'File video tidak valid.');
                return;
            }

            if (uploadType === 'image' && !getAllowedImageExtension(fileName, mimeType)) {
                sendError(res, 400, 'File image harus PNG, JPG, JPEG, WEBP, atau GIF.');
                return;
            }

            const uploadId = createId();
            const tempPath = path.join(UPLOAD_DIR, `${uploadId}.part`);
            await fs.writeFile(tempPath, '');

            uploadSessions.set(uploadId, {
                uploadType,
                fileName,
                mimeType,
                totalSize,
                tempPath,
                receivedBytes: 0,
                nextChunkIndex: 0,
                createdAt: Date.now()
            });

            sendJson(res, 201, { uploadId });
            return;
        }

        const chunkMatch = url.pathname.match(/^\/api\/admin\/uploads\/([^/]+)\/chunk$/);
        if (req.method === 'POST' && chunkMatch) {
            const upload = uploadSessions.get(chunkMatch[1]);
            if (!upload) {
                sendError(res, 404, 'Sesi upload tidak ditemukan.');
                return;
            }

            const body = await readJson(req);
            const parsed = parseDataUrl(body.dataUrl);
            const chunkIndex = Number(body.chunkIndex);

            if (!parsed || chunkIndex !== upload.nextChunkIndex) {
                sendError(res, 400, 'Chunk upload tidak valid.');
                return;
            }

            await fs.appendFile(upload.tempPath, parsed.buffer);
            upload.receivedBytes += parsed.buffer.length;
            upload.nextChunkIndex += 1;

            sendJson(res, 200, {
                receivedBytes: upload.receivedBytes,
                nextChunkIndex: upload.nextChunkIndex
            });
            return;
        }

        const imageFinishMatch = url.pathname.match(/^\/api\/admin\/images\/uploads\/([^/]+)\/finish$/);
        if (req.method === 'POST' && imageFinishMatch) {
            const upload = uploadSessions.get(imageFinishMatch[1]);
            if (!upload || upload.uploadType !== 'image') {
                sendError(res, 404, 'Sesi upload image tidak ditemukan.');
                return;
            }

            const body = await readJson(req);
            const title = String(body.title || '').trim() || upload.fileName.replace(/\.[^/.]+$/, '');
            const folderId = body.folderId ? String(body.folderId) : null;
            const adUrls = Array.isArray(body.adUrls)
                ? body.adUrls.map(url => String(url || '').trim()).filter(Boolean)
                : [String(body.adUrl || '').trim()].filter(Boolean);
            const adUrl = adUrls[0] || '';
            const requiredClicks = Math.max(1, Math.min(10, Number(body.requiredClicks || adUrls.length || 1)));
            const detectedExtension = await detectImageExtension(upload.tempPath);
            if (!detectedExtension) {
                await removeFile(upload.tempPath);
                uploadSessions.delete(imageFinishMatch[1]);
                sendError(res, 400, 'File bukan gambar yang valid.');
                return;
            }

            let folder = null;
            if (folderId) {
                const folders = await readFolders();
                folder = folders.find(item => item.id === folderId);
                if (!folder) {
                    sendError(res, 404, 'Folder tidak ditemukan.');
                    return;
                }
            }

            const images = await readImages();
            const shortCode = createImageCode(images);
            const imageNumber = folderId
                ? images.filter(image => image.folderId === folderId).length + 1
                : images.length + 1;
            const autoBaseName = createAutoMediaBaseName(folder ? `${folder.title} pic` : 'FOTO', imageNumber);
            const storedFileName = await createUniqueStoredFileName(IMAGE_DIR, autoBaseName, detectedExtension);
            const storedPath = path.join(IMAGE_DIR, storedFileName);
            const displayTitle = folder ? autoBaseName : title;
            const stat = await fs.stat(upload.tempPath);

            await fs.rename(upload.tempPath, storedPath);
            uploadSessions.delete(imageFinishMatch[1]);

            const image = {
                id: createId(),
                folderId,
                shortCode,
                title: displayTitle,
                imageUrl: `/images/${shortCode}${detectedExtension}`,
                fileName: storedFileName,
                storedFileName,
                adUrl,
                adUrls,
                requiredClicks,
                mimeType: contentTypes[detectedExtension] || upload.mimeType,
                size: stat.size,
                createdAt: new Date().toISOString()
            };

            images.unshift(image);
            await saveImages(images);
            sendJson(res, 201, { image: sanitizeImage(image) });
            return;
        }

        const finishMatch = url.pathname.match(/^\/api\/admin\/uploads\/([^/]+)\/finish$/);
        if (req.method === 'POST' && finishMatch) {
            const upload = uploadSessions.get(finishMatch[1]);
            if (!upload || upload.uploadType === 'image') {
                sendError(res, 404, 'Sesi upload tidak ditemukan.');
                return;
            }

            const body = await readJson(req);
            const title = String(body.title || '').trim();
            const adUrls = Array.isArray(body.adUrls)
                ? body.adUrls.map(url => String(url || '').trim()).filter(Boolean)
                : [String(body.adUrl || '').trim()].filter(Boolean);
            const adUrl = adUrls[0] || '';
            const folderId = body.folderId ? String(body.folderId) : null;
            const requiredClicks = Math.max(1, Math.min(10, Number(body.requiredClicks || adUrls.length || 1)));

            if (!title || !adUrls.length || upload.receivedBytes < 1) {
                sendError(res, 400, 'Data video tidak lengkap.');
                return;
            }

            const folders = await readFolders();
            const folder = folderId ? folders.find(item => item.id === folderId) : null;
            if (folderId) {
                if (!folder) {
                    sendError(res, 404, 'Folder tidak ditemukan.');
                    return;
                }
            }

            const videos = await readVideos();
            const id = createId();
            const extension = getExtension(upload.fileName, upload.mimeType);
            const shortCode = createShortCode(videos);
            const videoNumber = folderId
                ? videos.filter(video => video.folderId === folderId).length + 1
                : videos.filter(video => !video.folderId).length + 1;
            const autoBaseName = createAutoMediaBaseName(folder ? folder.title : 'VIDEO', videoNumber);
            const storedFileName = await createUniqueStoredFileName(UPLOAD_DIR, autoBaseName, extension);
            const storedPath = path.join(UPLOAD_DIR, storedFileName);
            const displayTitle = folder ? autoBaseName : title;

            await fs.rename(upload.tempPath, storedPath);
            uploadSessions.delete(finishMatch[1]);

            const video = {
                id,
                folderId,
                shortCode,
                title: displayTitle,
                videoUrl: `/u/${shortCode}${extension}`,
                fileName: storedFileName,
                storedFileName,
                adUrl,
                adUrls,
                requiredClicks,
                views: 0,
                clicks: 0,
                isEnabled: true,
                createdAt: new Date().toISOString()
            };

            videos.unshift(video);

            await saveVideos(videos);
            ensureVideoThumbnail(video).catch(() => {});
            scheduleVideoCompressionIfNeeded(video).catch(() => {});
            scheduleTelegramBackup(video).catch(() => {});
            sendJson(res, 201, { video: sanitizeVideo(video) });
            return;
        }

        const manualBackupMatch = url.pathname.match(/^\/api\/admin\/telegram-backups\/videos\/([^/]+)$/);
        if (req.method === 'POST' && manualBackupMatch) {
            const videos = await readVideos();
            const video = videos.find(item => item.id === manualBackupMatch[1] || item.shortCode === manualBackupMatch[1]);
            if (!video) {
                sendError(res, 404, 'Video tidak ditemukan.');
                return;
            }
            await scheduleTelegramBackup(video);
            sendJson(res, 200, { ok: true, message: 'Backup dijadwalkan.' });
            return;
        }

        const compressMatch = url.pathname.match(/^\/api\/admin\/videos\/([^/]+)\/compress$/);
        if (req.method === 'POST' && compressMatch) {
            const videos = await readVideos();
            const video = videos.find(item => item.id === compressMatch[1] || item.shortCode === compressMatch[1]);
            if (!video) {
                sendError(res, 404, 'Video tidak ditemukan.');
                return;
            }

            const body = await readJson(req).catch(() => ({}));
            const force = Boolean(body && body.force);

            await updateVideoFields(video.id, {
                compressionStatus: 'queued',
                compressionError: null,
                compressionReason: null,
                compressionUpdatedAt: new Date().toISOString()
            });

            enqueueVideoCompression(video, { force }).catch(() => {});
            sendJson(res, 200, { ok: true, message: 'Kompresi video dijadwalkan.' });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/videos/compress-all') {
            const body = await readJson(req).catch(() => ({}));
            const force = Boolean(body && body.force);
            const videos = await readVideos();
            let queued = 0;
            let skippedUnderThreshold = 0;
            for (const video of videos) {
                if (!video || !video.id) continue;
                if (videoCompressionPending.has(video.id)) continue;
                try {
                    const filePath = getVideoFilePath(video);
                    const stat = await fs.stat(filePath);
                    if (stat.size < COMPRESS_MIN_BYTES) {
                        skippedUnderThreshold += 1;
                        continue;
                    }
                    if (!force && video.compressionStatus === 'done') continue;
                    if (!force && video.compressionStatus === 'skipped' && video.compressionReason === 'no_savings') continue;
                    await updateVideoFields(video.id, {
                        compressionStatus: 'queued',
                        compressionError: null,
                        compressionReason: null,
                        compressionUpdatedAt: new Date().toISOString()
                    });
                    enqueueVideoCompression(video, { force }).catch(() => {});
                    queued += 1;
                } catch {
                    // file missing, skip
                }
            }
            const thresholdMb = Math.round(COMPRESS_MIN_BYTES / (1024 * 1024));
            sendJson(res, 200, {
                ok: true,
                queued,
                skippedUnderThreshold,
                thresholdBytes: COMPRESS_MIN_BYTES,
                message: `${queued} video di atas ${thresholdMb} MB dijadwalkan kompresi.`
            });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/video-clips') {
            const body = await readJson(req);
            const sourceId = String(body.videoId || '').trim();
            const start = Math.max(0, Number(body.start || 0));
            const end = Number(body.end || 0);
            const title = String(body.title || '').trim();
            if (!sourceId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
                sendError(res, 400, 'Pilih video dan range detik yang valid.');
                return;
            }

            const videos = await readVideos();
            const source = videos.find(item => item.id === sourceId || item.shortCode === sourceId);
            if (!source) {
                sendError(res, 404, 'Video sumber tidak ditemukan.');
                return;
            }

            const inputPath = getVideoFilePath(source);
            const id = createId();
            const shortCode = createShortCode(videos);
            const clipNumber = videos.filter(video => video.sourceVideoId).length + 1;
            const storedFileName = await createUniqueStoredFileName(UPLOAD_DIR, createAutoMediaBaseName('CLIP', clipNumber), '.mp4');
            const outputPath = path.join(UPLOAD_DIR, storedFileName);
            await runFfmpegClip({
                inputPath,
                outputPath,
                start,
                duration: end - start
            });

            const clip = {
                id,
                folderId: null,
                shortCode,
                title: title || `${source.title} clip ${start}-${end}s`,
                videoUrl: `/u/${shortCode}.mp4`,
                fileName: storedFileName,
                storedFileName,
                sourceVideoId: source.id,
                clipRange: { start, end },
                adUrl: source.adUrl || '',
                adUrls: Array.isArray(source.adUrls) ? source.adUrls : (source.adUrl ? [source.adUrl] : []),
                requiredClicks: source.requiredClicks || 1,
                views: 0,
                clicks: 0,
                isEnabled: true,
                createdAt: new Date().toISOString()
            };

            videos.unshift(clip);
            await saveVideos(videos);
            ensureVideoThumbnail(clip).catch(() => {});
            scheduleVideoCompressionIfNeeded(clip).catch(() => {});
            scheduleTelegramBackup(clip).catch(() => {});
            sendJson(res, 201, { video: sanitizeVideo(clip), downloadUrl: clip.videoUrl });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/telegram-backups/backup-all') {
            const videos = await readVideos();
            let queued = 0;
            for (const video of videos) {
                if (video && video.videoUrl) {
                    queued += 1;
                    scheduleTelegramBackup(video).catch(error => {
                        updateBackupRecord(video.id, {
                            status: 'failed',
                            error: error.message || 'Backup Telegram gagal.'
                        }).catch(() => {});
                    });
                }
            }
            sendJson(res, 200, { ok: true, queued, message: `${queued} video dijadwalkan backup.` });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/telegram-backups/rescan') {
            try {
                const result = await telegramRescan.rescan({
                    logger: msg => console.log(`[rescan] ${msg}`)
                });
                sendJson(res, 200, {
                    ok: true,
                    scannedMessages: result.scannedMessages,
                    videoCount: result.videoCount,
                    folderCount: result.folderCount,
                    message: `Rescan selesai. ${result.videoCount} video dan ${result.folderCount} folder ditemukan.`
                });
            } catch (error) {
                sendError(res, 500, error.message || 'Rescan Telegram gagal.');
            }
            return;
        }

        const restoreVideoMatch = url.pathname.match(/^\/api\/admin\/telegram-backups\/videos\/([^/]+)\/restore$/);
        if (req.method === 'POST' && restoreVideoMatch) {
            const backups = await readTelegramBackups();
            const record = backups.videos[restoreVideoMatch[1]];
            if (!record || !record.telegram || !record.videoSnapshot) {
                sendError(res, 404, 'Backup video tidak ditemukan.');
                return;
            }
            const body = await readJson(req).catch(() => ({}));
            const force = Boolean(body && body.force);
            enqueueRestore(record, { force }).catch(() => {});
            sendJson(res, 200, { ok: true, message: 'Restore dijadwalkan.', video: sanitizeVideo(record.videoSnapshot) });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/telegram-backups/restore-all') {
            const body = await readJson(req).catch(() => ({}));
            const force = Boolean(body && body.force);
            const backups = await readTelegramBackups();
            const records = Object.values(backups.videos || {})
                .filter(record => record && record.telegram && record.videoSnapshot);
            let queued = 0;
            for (const record of records) {
                if (videoRestorePending.has(record.videoSnapshot.id)) continue;
                enqueueRestore(record, { force }).catch(() => {});
                queued += 1;
            }
            sendJson(res, 200, { ok: true, queued, message: `${queued} video dijadwalkan restore.${force ? ' (paksa download ulang)' : ''}` });
            return;
        }

        const folderEnabledMatch = url.pathname.match(/^\/api\/admin\/folders\/([^/]+)\/enabled$/);
        if (req.method === 'PUT' && folderEnabledMatch) {
            const id = folderEnabledMatch[1];
            const body = await readJson(req);
            const folders = await readFolders();
            const folder = folders.find(item => item.id === id);
            if (!folder) {
                sendError(res, 404, 'Folder tidak ditemukan.');
                return;
            }

            folder.isEnabled = Boolean(body.isEnabled);
            await saveFolders(folders);
            const videos = await readVideos();
            sendJson(res, 200, { folders: folders.map(item => sanitizeFolder(item, videos)) });
            return;
        }

        const folderDeleteMatch = url.pathname.match(/^\/api\/admin\/folders\/([^/]+)$/);
        if (req.method === 'DELETE' && folderDeleteMatch) {
            const id = folderDeleteMatch[1];
            const folders = await readFolders();
            const folder = folders.find(item => item.id === id);
            if (!folder) {
                sendError(res, 404, 'Folder tidak ditemukan.');
                return;
            }

            const videos = await readVideos();
            const folderVideos = videos.filter(video => video.folderId === id);
            for (const video of folderVideos) {
                const filePath = getVideoFilePath(video);
                if (filePath.startsWith(UPLOAD_DIR)) {
                    await removeFile(filePath);
                }
            }

            await saveVideos(videos.filter(video => video.folderId !== id));
            await saveFolders(folders.filter(item => item.id !== id));
            sendJson(res, 200, { ok: true });
            return;
        }

        const enabledMatch = url.pathname.match(/^\/api\/admin\/videos\/([^/]+)\/enabled$/);
        if (req.method === 'PUT' && enabledMatch) {
            const id = enabledMatch[1];
            const body = await readJson(req);
            const videos = await readVideos();
            const video = videos.find(item => item.id === id);
            if (!video) {
                sendError(res, 404, 'Video tidak ditemukan.');
                return;
            }

            video.isEnabled = Boolean(body.isEnabled);
            await saveVideos(videos);
            sendJson(res, 200, { videos: videos.map(sanitizeVideo) });
            return;
        }

        const deleteMatch = url.pathname.match(/^\/api\/admin\/videos\/([^/]+)$/);
        if (req.method === 'DELETE' && deleteMatch) {
            const id = deleteMatch[1];
            const videos = await readVideos();
            const target = videos.find(video => video.id === id);
            if (!target) {
                sendError(res, 404, 'Video tidak ditemukan.');
                return;
            }

            const nextVideos = videos.filter(video => video.id !== id);

            const filePath = getVideoFilePath(target);
            if (filePath.startsWith(UPLOAD_DIR)) {
                await removeFile(filePath);
            }

            await saveVideos(nextVideos);
            sendJson(res, 200, { videos: nextVideos.map(sanitizeVideo) });
            return;
        }

        sendError(res, 404, 'Endpoint admin tidak ditemukan.');
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/public/active-video') {
        const videos = await readVideos();
        const activeVideo = videos.find(video => video.isEnabled !== false) || null;
        if (!activeVideo) {
            sendJson(res, 200, { video: null });
            return;
        }

        sendJson(res, 200, {
            video: {
                id: activeVideo.id,
                title: activeVideo.title,
                videoUrl: activeVideo.videoUrl,
                adUrl: activeVideo.adUrl,
                adUrls: Array.isArray(activeVideo.adUrls) ? activeVideo.adUrls : (activeVideo.adUrl ? [activeVideo.adUrl] : []),
                requiredClicks: activeVideo.requiredClicks,
                folderId: activeVideo.folderId || null
            }
        });
        recordVisitor(req, {
            type: 'video',
            targetId: activeVideo.id,
            targetTitle: activeVideo.title,
            path: url.pathname
        }).catch(() => {});
        return;
    }

    const publicVideoMatch = url.pathname.match(/^\/api\/public\/videos\/([^/]+)$/);
    if (req.method === 'GET' && publicVideoMatch) {
        const videos = await readVideos();
        const identifier = publicVideoMatch[1];
        const video = videos.find(item => item.id === identifier || item.shortCode === identifier);
        if (!video || video.isEnabled === false) {
            sendJson(res, 200, { video: null });
            return;
        }

        sendJson(res, 200, {
            video: {
                id: video.id,
                title: video.title,
                videoUrl: video.videoUrl,
                adUrl: video.adUrl,
                adUrls: Array.isArray(video.adUrls) ? video.adUrls : (video.adUrl ? [video.adUrl] : []),
                requiredClicks: video.requiredClicks,
                folderId: video.folderId || null
            }
        });
        recordVisitor(req, {
            type: 'video',
            targetId: video.id,
            targetTitle: video.title,
            path: url.pathname
        }).catch(() => {});
        return;
    }

    const publicFolderMatch = url.pathname.match(/^\/api\/public\/folders\/([^/]+)$/);
    if (req.method === 'GET' && publicFolderMatch) {
        const folders = await readFolders();
        const videos = await readVideos();
        const images = await readImages();
        const identifier = publicFolderMatch[1];
        const folder = folders.find(item => item.id === identifier || item.shortCode === identifier);
        if (!folder || folder.isEnabled === false) {
            sendJson(res, 200, { folder: null });
            return;
        }

        const folderVideos = videos
            .filter(video => video.folderId === folder.id && video.isEnabled !== false)
            .map(video => ({
                id: video.id,
                title: video.title,
                shortCode: video.shortCode,
                videoUrl: video.videoUrl,
                thumbUrl: `/thumbs/${encodeURIComponent(video.shortCode || video.id)}.jpg`,
                requiredClicks: video.requiredClicks
            }));

        const folderImages = images.filter(image => image.folderId === folder.id);
        const previewImages = folderImages.slice(0, 4).map(image => ({
            id: image.id,
            imageUrl: image.imageUrl
        }));

        sendJson(res, 200, {
            folder: {
                id: folder.id,
                title: folder.title,
                shortCode: folder.shortCode,
                hasPics: folderImages.length > 0,
                picUrl: `/pic/${folder.shortCode || folder.id}`,
                picPreviews: previewImages,
                picCount: folderImages.length,
                videos: folderVideos
            }
        });
        recordVisitor(req, {
            type: 'folder',
            targetId: folder.id,
            targetTitle: folder.title,
            path: url.pathname
        }).catch(() => {});
        return;
    }

    const clickMatch = url.pathname.match(/^\/api\/public\/videos\/([^/]+)\/click$/);
    if (req.method === 'POST' && clickMatch) {
        const videos = await readVideos();
        const video = videos.find(item => item.id === clickMatch[1] || item.shortCode === clickMatch[1]);
        if (!video || video.isEnabled === false) {
            sendError(res, 404, 'Video tidak ditemukan.');
            return;
        }
        video.clicks = Number(video.clicks || 0) + 1;
        await saveVideos(videos);
        recordVisitor(req, {
            type: 'ad_click',
            targetId: video.id,
            targetTitle: video.title,
            path: url.pathname
        }).catch(() => {});
        sendJson(res, 200, { ok: true });
        return;
    }

    const viewMatch = url.pathname.match(/^\/api\/public\/videos\/([^/]+)\/view$/);
    if (req.method === 'POST' && viewMatch) {
        const videos = await readVideos();
        const video = videos.find(item => item.id === viewMatch[1] || item.shortCode === viewMatch[1]);
        if (!video || video.isEnabled === false) {
            sendError(res, 404, 'Video tidak ditemukan.');
            return;
        }
        video.views = Number(video.views || 0) + 1;
        await saveVideos(videos);
        recordVisitor(req, {
            type: 'video_view',
            targetId: video.id,
            targetTitle: video.title,
            path: url.pathname
        }).catch(() => {});
        sendJson(res, 200, { ok: true });
        return;
    }

    const picClickMatch = url.pathname.match(/^\/api\/public\/pics\/([^/]+)\/click$/);
    if (req.method === 'POST' && picClickMatch) {
        const folders = await readFolders();
        const identifier = picClickMatch[1];
        const folder = folders.find(item => item.id === identifier || item.shortCode === identifier);
        if (!folder || folder.isEnabled === false) {
            sendError(res, 404, 'Galeri foto tidak ditemukan.');
            return;
        }
        recordVisitor(req, {
            type: 'ad_click',
            targetId: folder.id,
            targetTitle: `${folder.title} pic`,
            path: url.pathname
        }).catch(() => {});
        sendJson(res, 200, { ok: true });
        return;
    }

    const publicPicMatch = url.pathname.match(/^\/api\/public\/pics\/([^/]+)$/);
    if (req.method === 'GET' && publicPicMatch) {
        const folders = await readFolders();
        const images = await readImages();
        const identifier = publicPicMatch[1];
        const folder = folders.find(item => item.id === identifier || item.shortCode === identifier);
        if (!folder || folder.isEnabled === false) {
            sendJson(res, 200, { pic: null });
            return;
        }

        const folderImages = images.filter(image => image.folderId === folder.id);
        const firstImage = folderImages[0] || {};
        sendJson(res, 200, {
            pic: {
                id: folder.id,
                title: `${folder.title} pic`,
                shortCode: folder.shortCode,
                adUrl: firstImage.adUrl || '',
                adUrls: Array.isArray(firstImage.adUrls) ? firstImage.adUrls : (firstImage.adUrl ? [firstImage.adUrl] : []),
                requiredClicks: firstImage.requiredClicks || 1,
                images: folderImages.map(image => ({
                    id: image.id,
                    title: image.title,
                    imageUrl: image.imageUrl
                }))
            }
        });
        recordVisitor(req, {
            type: 'pic',
            targetId: folder.id,
            targetTitle: `${folder.title} pic`,
            path: url.pathname
        }).catch(() => {});
        return;
    }

    sendError(res, 404, 'Endpoint tidak ditemukan.');
}

async function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/pemutar_video_fokus (1).html';
    if (pathname === '/admin') pathname = '/admin.html';
    if (pathname === '/admin/videos') pathname = '/admin.html';
    if (pathname === '/admin/images') pathname = '/admin.html';
    if (pathname === '/admin/links') pathname = '/admin.html';
    if (pathname === '/admin/telegram-bot') pathname = '/admin.html';
    if (pathname === '/admin/clips') pathname = '/admin.html';
    if (pathname.startsWith('/watch/')) pathname = '/pemutar_video_fokus (1).html';
    if (pathname.startsWith('/v/')) pathname = '/pemutar_video_fokus (1).html';
    if (pathname.startsWith('/f/')) pathname = '/pemutar_video_fokus (1).html';
    if (pathname.startsWith('/pic/')) pathname = '/pemutar_video_fokus (1).html';

    if (pathname === '/ads-prebid-sponsor-check.js') {
        const body = 'window.__webaffSponsorCheck = true;';
        res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
        });
        res.end(body);
        return;
    }

    const thumbMatch = pathname.match(/^\/thumbs\/([^/]+)\.jpg$/);
    if (thumbMatch) {
        const videos = await readVideos();
        const video = videos.find(item => item.id === thumbMatch[1] || item.shortCode === thumbMatch[1]);
        if (!video) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const thumbPath = path.join(THUMB_DIR, `${video.id}.jpg`);
        try {
            const stat = await fs.stat(thumbPath);
            if (stat.size === 0) throw new Error('empty');
        } catch {
            const generated = await ensureVideoThumbnail(video).catch(() => null);
            if (!generated) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }
        }

        const stat = await fs.stat(thumbPath);
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': stat.size,
            'Accept-Ranges': 'none',
            'Cache-Control': 'public, max-age=86400'
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        fsNative.createReadStream(thumbPath).pipe(res);
        return;
    }

    if (pathname.startsWith('/images/')) {
        const fileName = path.basename(pathname);
        if (pathname !== `/images/${fileName}`) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const images = await readImages();
        const image = images.find(item => item.imageUrl === `/images/${fileName}` || item.storedFileName === fileName);
        if (!image) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const imagePath = getImageFilePath(image);
        const stat = await fs.stat(imagePath);
        if (!stat.isFile()) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const extension = path.extname(imagePath).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        res.writeHead(200, {
            'Content-Type': contentTypes[extension] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Accept-Ranges': 'none',
            'Content-Disposition': 'inline',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'public, max-age=86400'
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        fsNative.createReadStream(imagePath).pipe(res);
        return;
    }

    const allowedRootFiles = new Set([
        '/admin.html',
        '/pemutar_video_fokus (1).html'
    ]);
    const isUploadFile = pathname.startsWith('/uploads/') && pathname === `/uploads/${path.basename(pathname)}`;
    const isShortVideoFile = pathname.startsWith('/u/') && pathname === `/u/${path.basename(pathname)}`;
    let uploadTargetPath = null;
    if (isUploadFile || isShortVideoFile) {
        const videos = await readVideos();
        const video = videos.find(item => item.videoUrl === pathname || item.storedFileName === path.basename(pathname));
        if (!video) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        uploadTargetPath = getVideoFilePath(video);
    }
    if (!allowedRootFiles.has(pathname) && !isUploadFile && !isShortVideoFile) {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }

    const requestedPath = uploadTargetPath || path.normalize(path.join(ROOT, pathname));
    const rootPath = path.resolve(ROOT);
    const resolvedPath = path.resolve(requestedPath);
    if (resolvedPath !== rootPath && !resolvedPath.startsWith(rootPath + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    try {
        const stat = await fs.stat(requestedPath);
        if (!stat.isFile()) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const extension = path.extname(requestedPath).toLowerCase();
        const isVideo = ['.mp4', '.webm', '.ogg', '.mov', '.m4v'].includes(extension);
        const range = req.headers.range;

        if (isVideo && range) {
            const match = range.match(/bytes=(\d*)-(\d*)/);
            if (!match) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
            }

            const start = match[1] ? Number(match[1]) : 0;
            const end = match[2] ? Number(match[2]) : stat.size - 1;

            if (start >= stat.size || end >= stat.size || start > end) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
            }

            res.writeHead(206, {
                'Content-Type': contentTypes[extension] || 'application/octet-stream',
                'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Disposition': 'inline',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'public, max-age=3600'
            });
            fsNative.createReadStream(requestedPath, { start, end }).pipe(res);
            return;
        }

        if (isVideo) {
            res.writeHead(200, {
                'Content-Type': contentTypes[extension] || 'application/octet-stream',
                'Content-Length': stat.size,
                'Accept-Ranges': 'bytes',
                'Content-Disposition': 'inline',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'public, max-age=3600'
            });

            if (req.method === 'HEAD') {
                res.end();
                return;
            }

            fsNative.createReadStream(requestedPath).pipe(res);
            return;
        }

        res.writeHead(200, {
            'Content-Type': contentTypes[extension] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Accept-Ranges': 'none',
            'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600'
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        fsNative.createReadStream(requestedPath).pipe(res);
    } catch {
        res.writeHead(404);
        res.end('Not Found');
    }
}

async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
        if (url.pathname.startsWith('/api/')) {
            await handleApi(req, res, url);
            return;
        }

        await serveStatic(req, res, url);
    } catch (error) {
        if (!res.headersSent) {
            sendError(res, 500, error.message || 'Server error.');
        } else {
            res.end();
        }
    }
}

async function backfillVideoThumbnails() {
    try {
        const videos = await readVideos();
        for (const video of videos) {
            if (!video || !video.id) continue;
            const thumbPath = path.join(THUMB_DIR, `${video.id}.jpg`);
            try {
                const stat = await fs.stat(thumbPath);
                if (stat.size > 0) continue;
            } catch {
                // missing, generate below
            }
            await ensureVideoThumbnail(video).catch(() => {});
        }
    } catch {
        // ignore backfill failures
    }
}

ensureStorage().then(() => {
    http.createServer(handleRequest).listen(PORT, () => {
        console.log(`Server jalan di http://localhost:${PORT}`);
        console.log(`Admin panel: http://localhost:${PORT}/admin`);
        console.log(`Halaman user: http://localhost:${PORT}/`);
        if (IS_ANDROID) {
            console.log(`[android] mode aktif - default kompresi CPU ${DEFAULT_COMPRESS_CPU}% preset ${DEFAULT_COMPRESS_PRESET}.`);
        }
    });
    backfillVideoThumbnails().catch(() => {});
    backfillVideoCompression().catch(() => {});
});
