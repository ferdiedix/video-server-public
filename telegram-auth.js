const readline = require('readline');
const fs = require('fs').promises;
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || '';

if (!apiId || !apiHash) {
    console.error('Set TELEGRAM_API_ID dan TELEGRAM_API_HASH dulu.');
    process.exit(1);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

function normalizePhoneNumber(value) {
    let phone = String(value || '').trim().replace(/[\s-]/g, '');
    if (phone.startsWith('+')) return phone;
    if (phone.startsWith('0')) return `+62${phone.slice(1)}`;
    if (phone.startsWith('62')) return `+${phone}`;
    if (phone.startsWith('8')) return `+62${phone}`;
    return phone;
}

(async () => {
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
        connectionRetries: 5
    });

    await client.start({
        phoneNumber: async () => normalizePhoneNumber(await ask('Nomor Telegram (contoh 085... atau +6285...): ')),
        password: () => ask('Password 2FA jika ada: '),
        phoneCode: () => ask('Kode login Telegram: '),
        onError: error => console.error(error)
    });

    const session = client.session.save();
    const output = path.join(__dirname, 'data', 'telegram-session.txt');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, session, 'utf8');
    console.log('\nSession tersimpan di:');
    console.log(output);
    console.log('\nTambahkan ke service env:');
    console.log(`Environment=TELEGRAM_SESSION=${session}`);
    await client.disconnect();
    rl.close();
})();
