# Webaff Video Fokus

Webaff Video Fokus adalah aplikasi web ringan untuk mengelola, membagikan, dan memutar video dengan sistem direct-link/sponsor gate. Project ini dibuat untuk berjalan sederhana di VPS kecil atau bahkan Android via Termux, tanpa framework backend besar, tanpa database server, dan tanpa build step.

Backend memakai Node.js native `http`, frontend berupa HTML standalone dengan Tailwind CDN, dan seluruh data disimpan dalam file JSON lokal.

## Fitur Utama

- Admin panel dengan login PIN dan lockout IP setelah percobaan gagal berulang.
- Upload video, folder video, dan gambar dari browser.
- Public player dengan direct-link/sponsor verification sebelum video diputar.
- Folder unlock cache 30 menit di browser, sehingga user tidak harus klik sponsor berulang untuk konten dalam folder yang sama.
- Short link untuk video, folder, dan galeri foto.
- Statistik views, klik sponsor, visitor log, dan GeoIP.
- Server monitor untuk CPU, RAM, storage, network, compression queue, dan restore queue.
- Video thumbnail otomatis via `ffmpeg`.
- Video clipping tool untuk membuat potongan video baru.
- Kompresi video via `ffmpeg` dengan queue, threshold ukuran, CRF, preset, dan limit CPU.
- Backup video ke Telegram via GramJS.
- Restore video dari Telegram backup.
- Rescan Telegram untuk membangun ulang metadata dari caption backup.
- Telegram Bot sender untuk mengirim video/gambar/caption ke chat atau grup.
- Termux installer dan helper scripts untuk deploy di Android.

## Stack

- Runtime: Node.js
- Backend: native `http` module, tanpa Express
- Frontend: HTML standalone + JavaScript inline + Tailwind CDN
- Database: JSON files di folder `data/`
- Media storage: local filesystem
- Video processing: `ffmpeg`
- Telegram backup: GramJS package `telegram`
- Deployment tested: Termux Android + Cloudflare Tunnel

## Struktur Project

```text
.
├── server.js                    # Main HTTP server, API router, static server
├── admin.html                   # Admin SPA
├── pemutar_video_fokus (1).html # Public video/image player
├── telegram-backup.js           # GramJS upload/restore helper
├── telegram-rescan.js           # Scan Telegram backup chat and rebuild data
├── telegram-auth.js             # CLI login for Telegram StringSession
├── setup-termux.sh              # One-shot Termux installer
├── package.json
├── data/                        # JSON database files
├── uploads/                     # Stored video files
├── images/                      # Stored image files
└── thumbnails/                  # Generated video thumbnails
```

## Data Files

Data disimpan sebagai JSON biasa di folder `data/`.

| File | Fungsi |
| --- | --- |
| `videos.json` | Metadata video, short code, direct link, views, clicks, compression state |
| `folders.json` | Metadata folder video |
| `images.json` | Metadata gambar dan galeri foto |
| `link-bank.json` | Bank URL direct-link/sponsor |
| `visitors.json` | Log visitor, views, klik, IP, GeoIP |
| `telegram-backups.json` | Status backup/restore Telegram per video/folder |
| `telegram-bot.json` | Token bot dan target chat untuk Bot API sender |
| `security.json` | Login attempts dan lockout state |

## Cara Kerja Singkat

### Admin Upload

1. Admin login memakai PIN.
2. Browser membuat upload session lewat `/api/admin/uploads/start`.
3. File dikirim ke server.
4. Setelah semua file masuk, metadata difinalisasi ke JSON.
5. Video baru dijadwalkan backup ke Telegram setelah batch upload selesai.

Untuk file kecil di bawah 90 MB, upload memakai single stream supaya tidak banyak request kecil. File besar tetap diproses dengan segment upload agar aman dari batas upload Cloudflare.

### Public Player

1. User buka `/`, `/v/:code`, `/watch/:code`, `/f/:code`, atau `/pic/:code`.
2. Player mengambil metadata public dari API.
3. User harus membuka direct-link/sponsor sesuai `requiredClicks`.
4. Setelah verifikasi selesai, video atau galeri dibuka.
5. View dan click dicatat ke `visitors.json`.

### Telegram Backup

Video dibackup ke Telegram dengan caption:

```text
WEBAPP_BACKUP
{...json snapshot video dan folder...}
```

Caption ini memungkinkan `telegram-rescan.js` membaca ulang chat backup dan membangun metadata lokal kembali.

## Requirements

- Node.js 18+ direkomendasikan
- npm
- ffmpeg di PATH
- Git
- Opsional: Cloudflare Tunnel (`cloudflared`) untuk akses publik
- Opsional: akun Telegram API untuk backup/restore via GramJS

## Install Lokal

```bash
git clone https://github.com/ferdiedix/video-server-public.git
cd video-server-public
npm install
npm start
```

Buka:

```text
http://localhost:3000
http://localhost:3000/admin
```

PIN default admin adalah `1234`. Ganti lewat environment variable `ADMIN_PIN` sebelum dipakai publik.

## Environment Variables

Contoh `.env`:

```env
PORT=3000
ADMIN_PIN=1234

# Upload/playback bandwidth throttle per IP. Set 0 untuk disable.
BANDWIDTH_PER_USER_KBPS=1500
BANDWIDTH_BURST_MULTIPLIER=8

# Video compression
COMPRESS_MIN_BYTES=104857600
COMPRESS_CRF=23
COMPRESS_PRESET=fast
COMPRESS_AUDIO_BITRATE=128k
COMPRESS_MIN_SAVING=0.15
COMPRESS_CPU_PERCENT=30
COMPRESS_NICENESS=10
COMPRESS_AUTO_ON_UPLOAD=false
COMPRESS_AUTO_BACKFILL=false

# Telegram backup via GramJS
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=
TELEGRAM_BACKUP_CHAT=@your_backup_chat
TELEGRAM_USE_FORUM_TOPICS=true
TELEGRAM_UPLOAD_WORKERS=4
```

## Telegram Setup

### 1. Ambil API ID dan Hash

Buat aplikasi Telegram di:

```text
https://my.telegram.org/apps
```

### 2. Generate Session

```bash
TELEGRAM_API_ID=123456 TELEGRAM_API_HASH=your_hash npm run telegram:auth
```

Session akan tersimpan di:

```text
data/telegram-session.txt
```

Masukkan isi session tersebut ke env `TELEGRAM_SESSION`.

### 3. Set Backup Chat

Gunakan username grup/channel atau ID chat:

```env
TELEGRAM_BACKUP_CHAT=@backupaffku
```

Jika chat memakai forum topics per folder:

```env
TELEGRAM_USE_FORUM_TOPICS=true
```

## Deploy di Termux Android

Project ini menyediakan installer khusus Termux:

```bash
bash setup-termux.sh
```

Script akan menginstal dependency sistem seperti Node.js, ffmpeg, git, jq, termux-api, membuat file `.env`, helper scripts, dan hook Termux:Boot.

Helper scripts:

```bash
bash scripts/start.sh     # Jalankan foreground
bash scripts/start-bg.sh  # Jalankan background
bash scripts/stop.sh      # Matikan server
bash scripts/status.sh    # Cek status
bash scripts/logs.sh      # Lihat log
```

Untuk akses publik aman tanpa port forwarding, gunakan Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

## Route Penting

### Public

| Route | Fungsi |
| --- | --- |
| `/` | Player untuk video aktif pertama |
| `/v/:code` | Player video berdasarkan short code |
| `/watch/:code` | Alias player video |
| `/f/:code` | Folder video |
| `/pic/:code` | Galeri foto folder |
| `/u/:file` | Stream video file |
| `/images/:file` | Serve image file |
| `/thumbs/:code.jpg` | Serve thumbnail |

### Admin UI

| Route | Fungsi |
| --- | --- |
| `/admin` | Upload video dan dashboard |
| `/admin/images` | Upload gambar |
| `/admin/links` | Bank direct-link |
| `/admin/telegram-bot` | Bot sender |
| `/admin/clips` | Potong video |

### Admin API

Admin API memakai Bearer token dari login.

| Endpoint | Fungsi |
| --- | --- |
| `POST /api/admin/login` | Login admin |
| `GET /api/admin/videos` | List video |
| `GET /api/admin/folders` | List folder |
| `GET /api/admin/images` | List images |
| `GET /api/admin/link-bank` | List direct-link bank |
| `POST /api/admin/uploads/start` | Mulai upload session |
| `POST /api/admin/uploads/:id/upload` | Single stream upload |
| `POST /api/admin/uploads/:id/segment` | Segment upload file besar |
| `POST /api/admin/uploads/:id/finish` | Finalisasi upload video |
| `POST /api/admin/images/uploads/:id/finish` | Finalisasi upload image |
| `POST /api/admin/telegram-backups/backup-all` | Backup semua atau video tertentu |
| `POST /api/admin/telegram-backups/rescan` | Rescan Telegram backup chat |
| `POST /api/admin/telegram-backups/restore-all` | Restore semua backup |
| `GET /api/admin/server-status` | Status server |
| `GET /api/admin/compression-queue` | Status kompresi |
| `GET /api/admin/restore-queue` | Status restore |

## Performance Notes

- File di bawah 90 MB diupload sebagai single stream untuk mengurangi overhead request.
- File besar tetap dipecah agar tidak melewati batas upload Cloudflare Free 100 MB.
- Upload folder diproses dalam fase: upload semua file, finalisasi metadata, lalu backup Telegram.
- Finalisasi metadata dilakukan serial untuk mencegah race condition pada JSON database.
- Kompresi video tidak otomatis aktif kecuali `COMPRESS_AUTO_ON_UPLOAD=true`.
- Bandwidth playback bisa dibatasi per IP lewat `BANDWIDTH_PER_USER_KBPS`.

## Security Notes

- Ganti `ADMIN_PIN` sebelum expose ke publik.
- Jangan commit `.env`, token bot, atau Telegram session.
- `data/telegram-session.txt` sensitif. Simpan aman.
- Admin session disimpan in-memory, restart server akan logout semua admin.
- JSON storage tidak punya locking penuh seperti database server. Hindari terlalu banyak operasi tulis paralel.

## Known Limitations

- Database JSON cocok untuk deployment kecil-menengah, bukan traffic sangat tinggi.
- Banyak proses tulis bersamaan bisa menyebabkan race jika tidak diserialkan.
- Monitoring network di Android/Termux non-root sering terbatas oleh permission sistem.
- `ffmpeg` wajib tersedia untuk thumbnail, clipping, dan compression.
- Cloudflare Free memiliki batas upload request 100 MB, sehingga file besar harus segment upload.

## Development

Jalankan server:

```bash
npm start
```

Generate Telegram session:

```bash
npm run telegram:auth
```

Tidak ada build step. Edit `server.js`, `admin.html`, atau `pemutar_video_fokus (1).html`, lalu restart server.

## License

Project ini belum mendefinisikan lisensi eksplisit. Tambahkan file `LICENSE` jika ingin dipublikasikan dengan lisensi tertentu.

## Author

Dibuat untuk workflow upload dan distribusi video ringan dengan direct-link gating, Telegram backup, dan deployment hemat resource.
