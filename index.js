const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { toDataURL } = require('qrcode');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('./config.json');
const birthdays = require('./birthdays.json');
const { getGrupoSemana, getProximoDia } = require('./rotation');

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, 'auth_info');
let sock = null;
let retryCount = 0;
const cronTasks = {};

// Clean up old puppeteer stuff
['.wwebjs_auth', '.wwebjs_cache'].forEach(d => {
    const p = path.join(__dirname, d);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
});

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot running');
});
server.listen(PORT, () => console.log(`Health check en puerto ${PORT}`));

async function startBot() {
    if (fs.existsSync(AUTH_DIR)) {
        const files = fs.readdirSync(AUTH_DIR).filter(f => f !== 'creds.json' && f.endsWith('.json'));
        const hasCreds = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
        console.error(`Auth ${hasCreds ? 'OK' : 'vacío'} (${files.length} sesiones)`);
    } else {
        console.error('Auth nuevo — se necesita QR');
    }
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.error(`Baileys v${version.join('.')}, latest=${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const now = new Date().toLocaleTimeString();
                const dataUrl = await toDataURL(qr, { width: 200, margin: 1 });
                console.error(`[${now}] QR NUEVO - copia y pega en navegador:`);
                console.error(dataUrl);
            } catch (e) {
                console.error('Error QR:', e);
            }
            return;
        }

        if (connection === 'open') {
            console.error('=== CONECTADO A WHATSAPP ===');
            config.schedules.forEach(s => {
                if (s.active) iniciarProgramador(s);
            });
            if (birthdayTask) birthdayTask.stop();
            birthdayTask = cron.schedule('0 9 * * *', () => revisarCumpleanos());
            revisarCumpleanos();
            console.error('Revisión de cumpleaños activada (9:00 AM)');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.error(`Desconectado. Código: ${statusCode} (intento #${retryCount + 1})`);
            if (statusCode === DisconnectReason.loggedOut) {
                console.error('Sesión cerrada — eliminando auth y reiniciando');
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                retryCount = 0;
            }
            const delay = Math.min(30000 * Math.pow(2, retryCount), 300000); // up to 5 min
            retryCount++;
            console.error(`Reconectando en ${delay / 1000}s...`);
            setTimeout(() => startBot(), delay);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            const key = msg.key;
            const fromMe = key?.fromMe;
            const jid = key?.remoteJid;
            const body = msg.message?.conversation ||
                         msg.message?.extendedTextMessage?.text ||
                         msg.message?.imageMessage?.caption || '';

            console.error(`MSG: fromMe=${fromMe} jid=${jid} body="${body.substring(0,30)}"`);

            if (!body || !config.comandosHabilitados) continue;

            if (body.toLowerCase() === '!proximo') {
                try {
                    let r = '📅 *Próximos eventos*\n\n';
                    config.schedules.filter(s => s.active).sort((a, b) => (a.targetDay || 7) - (b.targetDay || 7)).forEach(s => {
                        const grupo = getGrupoSemana(s);
                        const target = getProximoDia(s.targetDay);
                        const f = target.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
                        const d = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][s.targetDay];
                        r += `▸ *${d}* (${f}): ${grupo.label}\n`;
                    });
                    console.error(`ENVIANDO respuesta a ${jid}`);
                    await sock.sendMessage(jid, { text: r });
                    console.error('RESPUESTA ENVIADA');
                } catch (e) { console.error('Error !proximo:', e.message); }
            }

            if (body.toLowerCase() === '!grupos') {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    let lista = '📋 *Grupos del bot*\n\n';
                    Object.entries(groups).forEach(([id, g]) => { lista += `▸ ${g.subject}\n  ID: ${id}\n\n`; });
                    await sock.sendMessage(jid, { text: lista });
                } catch (e) { console.error('Error !grupos:', e.message); }
            }
        }
    });
}

let birthdayTask = null;

function revisarCumpleanos() {
    const hoy = new Date();
    const dia = hoy.getDate();
    const mes = hoy.getMonth() + 1;
    const cumples = birthdays.filter(b => b.day === dia && b.month === mes);
    if (cumples.length === 0) return;
    const names = cumples.map(c => `*${c.name}*`);
    let msg;
    if (cumples.length === 1) {
        msg = `🎂 Hoy está de fiesta de cumpleaños: ${names[0]} 🎉\n\nQue Dios te bendiga en este día especial. 🙏`;
    } else if (cumples.length === 2) {
        msg = `🎂 Hoy están de fiesta de cumpleaños: ${names[0]} y ${names[1]} 🎉\n\nQue Dios los bendiga en este día especial. 🙏`;
    } else {
        const last = names.pop();
        msg = `🎂 Hoy están de fiesta de cumpleaños: ${names.join(', ')} y ${last} 🎉\n\nQue Dios los bendiga en este día especial. 🙏`;
    }
    sock.sendMessage(config.groupId, { text: msg }).catch(() => {});
    console.error(`Cumpleaños hoy: ${cumples.map(c => c.name).join(', ')}`);
}

function iniciarProgramador(schedule) {
    const diaSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][schedule.targetDay];

    if (cronTasks[schedule.name]) {
        cronTasks[schedule.name].stop();
    }
    console.error(`Programador: ${schedule.name} → ${schedule.cron}`);

    cronTasks[schedule.name] = cron.schedule(schedule.cron, async () => {
        try {
            const grupo = getGrupoSemana(schedule);
            const target = getProximoDia(schedule.targetDay);
            const fecha = target.toLocaleDateString('es-ES', {
                weekday: 'long', day: 'numeric', month: 'long'
            });
            const mensaje = schedule.messageTemplate
                .replace('{fecha}', fecha)
                .replace('{label}', grupo.label);

            if (grupo.image) {
                const imagePath = path.join(__dirname, grupo.image);
                if (fs.existsSync(imagePath)) {
                    const img = fs.readFileSync(imagePath);
                    const ext = path.extname(imagePath).slice(1);
                    await sock.sendMessage(config.groupId, {
                        image: img,
                        caption: mensaje,
                        mimetype: `image/${ext === 'jpg' ? 'jpeg' : ext}`
                    });
                } else {
                    await sock.sendMessage(config.groupId, { text: mensaje });
                }
            } else {
                await sock.sendMessage(config.groupId, { text: mensaje });
            }
            console.error(`[${schedule.name}] Enviado: ${grupo.name}`);
        } catch (err) {
            console.error(`[${schedule.name}] Error:`, err.message);
        }
    });
}

startBot();

process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (err) => console.error('No capturado:', err.message));
process.on('unhandledRejection', (err) => console.error('Rechazo:', err.message));
