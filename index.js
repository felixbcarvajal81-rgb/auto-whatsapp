const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { toDataURL } = require('qrcode');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('./config.json');
const { getGrupoSemana, getProximoDia } = require('./rotation');

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, 'auth_info');
let sock = null;

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
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
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
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.error(`Desconectado. Código: ${statusCode}. Mensaje: ${lastDisconnect?.error?.message}`);
            if (statusCode === DisconnectReason.loggedOut) {
                console.error('Sesión cerrada, eliminando auth...');
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
            setTimeout(startBot, 3000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const body = msg.message?.conversation ||
                         msg.message?.extendedTextMessage?.text || '';
            if (!body || !config.comandosHabilitados) continue;
            console.error(`CMD: ${body} de ${msg.key.remoteJid}`);

            if (body.toLowerCase() === '!proximo') {
                try {
                    let r = '📅 *Próximos eventos*\n\n';
                    config.schedules.forEach(s => {
                        if (!s.active) return;
                        const grupo = getGrupoSemana(s);
                        const target = getProximoDia(s.targetDay);
                        const f = target.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
                        const d = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][s.targetDay];
                        r += `▸ *${d}* (${f}): ${grupo.label}\n`;
                    });
                    await sock.sendMessage(msg.key.remoteJid, { text: r });
                } catch (e) { console.error('Error !proximo:', e.message); }
            }

            if (body.toLowerCase() === '!grupos') {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    let lista = '📋 *Grupos del bot*\n\n';
                    Object.entries(groups).forEach(([id, g]) => { lista += `▸ ${g.subject}\n  ID: ${id}\n\n`; });
                    await sock.sendMessage(msg.key.remoteJid, { text: lista });
                } catch (e) { console.error('Error !grupos:', e.message); }
            }
        }
    });
}

function iniciarProgramador(schedule) {
    const diaSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][schedule.targetDay];
    console.error(`Programador: ${schedule.name} → ${schedule.cron}`);

    cron.schedule(schedule.cron, async () => {
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
