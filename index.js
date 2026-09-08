const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, extractMessageContent } = require('@whiskeysockets/baileys');
const { toDataURL } = require('qrcode');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('./config.json');
const birthdays = require('./birthdays.json');
const { getGrupoSemana, getProximoDia, getGruposProximos, ajustarRotacion } = require('./rotation');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

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
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/rotacion') {
        return servirPanelRotacion(res, url);
    }
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
            birthdayTask = cron.schedule('0 7 * * *', () => revisarCumpleanos());
            revisarCumpleanos();
            console.error('Revisión de cumpleaños activada (7:00 AM)');
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
            const body = extraerTexto(msg);

            console.error(`MSG: fromMe=${fromMe} jid=${jid} body="${body.substring(0,30)}"`);

            if (!body || !config.comandosHabilitados) continue;

            const lower = body.trim().toLowerCase();
            const [cmd, ...argParts] = lower.split(/\s+/);
            const arg = argParts.join(' ').trim();

            try {
                const destino = destinoComando(msg, cmd);
                if (cmd === '!proximo') {
                    await sock.sendMessage(destino, { text: textoProximos() });
                } else if (cmd === '!rotacion') {
                    await sock.sendMessage(destino, { text: textoRotacion() });
                } else if (cmd === '!atrasar' || cmd === '!saltar') {
                    await sock.sendMessage(destino, { text: aplicarRotacion(cmd === '!atrasar' ? 1 : -1, arg) });
                } else if (cmd === '!ayuda') {
                    await sock.sendMessage(destino, { text: textoAyuda() });
                } else if (cmd === '!grupos') {
                    const groups = await sock.groupFetchAllParticipating();
                    let lista = '📋 *Grupos del bot*\n\n';
                    Object.entries(groups).forEach(([id, g]) => { lista += `▸ ${g.subject}\n  ID: ${id}\n\n`; });
                    await sock.sendMessage(jid, { text: lista });
                }
            } catch (e) {
                console.error(`Error ${cmd}:`, e.message);
            }
        }
    });
}

let birthdayTask = null;
const BIRTHDAY_FLAG = path.join(AUTH_DIR, '.birthday_sent');

function revisarCumpleanos() {
    const hoy = new Date();
    const dia = hoy.getDate();
    const mes = hoy.getMonth() + 1;
    const todayKey = `${mes}-${dia}`;
    try {
        const sent = fs.readFileSync(BIRTHDAY_FLAG, 'utf8').trim();
        if (sent === todayKey) return;
    } catch (_) {}
    const cumples = birthdays.filter(b => b.day === dia && b.month === mes);
    if (cumples.length === 0) return;
    fs.writeFileSync(BIRTHDAY_FLAG, todayKey);
    const names = cumples.map(c => `*${c.name}*`);
    let msg;
    const bendicion = 'Que la gracia de Dios te cubra en este día 🙏';
    const bendicionPlural = 'Que la gracia de Dios los cubra en este día 🙏';
    if (cumples.length === 1) {
        msg = `🎂 Hoy está de fiesta de cumpleaños: ${names[0]} 🎉\n\n${bendicion}`;
    } else if (cumples.length === 2) {
        msg = `🎂 Hoy están de fiesta de cumpleaños: ${names[0]} y ${names[1]} 🎉\n\n${bendicionPlural}`;
    } else {
        const last = names.pop();
        msg = `🎂 Hoy están de fiesta de cumpleaños: ${names.join(', ')} y ${last} 🎉\n\n${bendicionPlural}`;
    }
    sock.sendMessage(config.groupId, { text: msg }).catch(() => {});
    console.error(`Cumpleaños hoy: ${cumples.map(c => c.name).join(', ')}`);
}

async function enviarProgramado(schedule) {
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
}

function iniciarProgramador(schedule) {
    const diaSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][schedule.targetDay];

    if (cronTasks[schedule.name]) {
        cronTasks[schedule.name].stop();
    }
    const hoy = new Date();
    const hoyStr = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
    const cronExpr = schedule.cron;
    console.error(`Programador: ${schedule.name} → ${cronExpr}`);

    cronTasks[schedule.name] = cron.schedule(cronExpr, () => enviarProgramado(schedule));

    if (schedule.overrideDate === hoyStr && schedule.overrideCron) {
        const parts = schedule.overrideCron.split(' ').map(Number);
        const target = new Date(hoy);
        target.setHours(parts[1], parts[0], 0, 0);
        let delay = target - hoy;
        if (delay < 0) delay = 0;
        console.error(`Programador: ${schedule.name} → override HOY a las ${parts[1]}:${String(parts[0]).padStart(2, '0')} (${delay / 1000}s)`);
        const timer = setTimeout(() => enviarProgramado(schedule), delay);
        cronTasks[schedule.name + ' (override)'] = { stop: () => clearTimeout(timer) };
    }
}

function guardarConfig() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4) + '\n');
}

function formatearFecha(date) {
    return date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

function rotables() {
    return config.schedules.filter(s => s.active && s.groups.length > 1);
}

function buscarRotacion(arg) {
    const q = (arg || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const lista = rotables();
    if (!q) return null;
    if (q.includes('viernes') || q.includes('ministerio')) {
        return lista.find(s => s.name === 'Ministerios Viernes') || null;
    }
    if (q.includes('domingo') || q.includes('crecimiento') || q.includes('grupo')) {
        return lista.find(s => s.name === 'Grupos Crecimiento Domingo') || null;
    }
    return lista.find(s => s.name.toLowerCase().includes(q)) || null;
}

function aliasRotacion(schedule) {
    if (schedule.name === 'Ministerios Viernes') return 'viernes';
    if (schedule.name === 'Grupos Crecimiento Domingo') return 'domingo';
    return schedule.name.toLowerCase();
}

function textoProximos() {
    let r = '📅 *Próximos eventos*\n\n';
    config.schedules.filter(s => s.active).sort((a, b) => (a.targetDay || 7) - (b.targetDay || 7)).forEach(s => {
        const grupo = getGrupoSemana(s);
        const target = getProximoDia(s.targetDay);
        r += `▸ *${DIAS[s.targetDay]}* (${formatearFecha(target)}): ${grupo.label}\n`;
    });
    return r;
}

function textoRotacion() {
    let r = '🔄 *Rotación*\n';
    rotables().forEach(s => {
        const proximos = getGruposProximos(s, 4);
        const alias = aliasRotacion(s);
        r += `\n*${s.name}*\n`;
        proximos.forEach((p, i) => {
            const f = formatearFecha(p.date);
            r += i === 0 ? `Próximo: *${p.group.name}* (${f})\n` : `Luego: ${p.group.name} (${f})\n`;
        });
        r += `▸ !atrasar ${alias}\n▸ !saltar ${alias}\n`;
    });
    return r;
}

function textoAyuda() {
    return [
        '📋 *Comandos*',
        '',
        '!proximo — próximos eventos',
        '!rotacion — ver quién dirige y ajustar',
        '!atrasar viernes — retrasar 1 semana',
        '!saltar viernes — pasar al siguiente',
        '!atrasar domingo — retrasar 1 semana',
        '!saltar domingo — pasar al siguiente',
        '!ayuda — esta lista'
    ].join('\n');
}

function aplicarRotacion(semanas, arg) {
    const lista = rotables();
    if (!arg) {
        let r = '¿Cuál rotación?\n';
        lista.forEach(s => { r += `▸ !${semanas > 0 ? 'atrasar' : 'saltar'} ${aliasRotacion(s)}\n`; });
        return r;
    }
    const schedule = buscarRotacion(arg);
    if (!schedule) {
        return `No encontré esa rotación.\nUsa *!atrasar viernes* o *!atrasar domingo*.`;
    }
    const antes = getGrupoSemana(schedule);
    ajustarRotacion(schedule, semanas);
    guardarConfig();
    const despues = getGrupoSemana(schedule);
    const fecha = formatearFecha(getProximoDia(schedule.targetDay));
    const accion = semanas > 0 ? 'Retrasada' : 'Saltada';
    console.error(`[rotación] ${accion} ${schedule.name}: ${antes.name} → ${despues.name}`);
    return `✅ *${accion}* la rotación de *${schedule.name}*\n\nAntes: ${antes.name}\nAhora dirige el ${DIAS[schedule.targetDay]} (${fecha}): *${despues.name}*`;
}

function extraerTexto(msg) {
    const content = extractMessageContent(msg.message) || msg.message || {};
    return content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        '';
}

function destinoComando(msg, cmd) {
    const jid = msg.key.remoteJid;
    const privado = cmd === '!rotacion' || cmd === '!atrasar' || cmd === '!saltar';
    if (privado && jid && jid.endsWith('@g.us')) {
        return msg.key.participant || jid;
    }
    return jid;
}

function servirPanelRotacion(res, url) {
    const key = url.searchParams.get('key') || '';
    if (!config.adminKey || key !== config.adminKey) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No autorizado');
        return;
    }
    const accion = url.searchParams.get('accion');
    const cual = url.searchParams.get('cual') || '';
    let aviso = '';
    if (accion === 'atrasar' || accion === 'saltar') {
        aviso = aplicarRotacion(accion === 'atrasar' ? 1 : -1, cual);
    }
    const k = encodeURIComponent(config.adminKey);
    let cards = '';
    rotables().forEach(s => {
        const alias = aliasRotacion(s);
        const proximos = getGruposProximos(s, 4);
        let lista = '';
        proximos.forEach((p, i) => {
            const f = formatearFecha(p.date);
            lista += i === 0
                ? `<p class="next">Próximo: <b>${p.group.name}</b><br><small>${f}</small></p>`
                : `<p class="later">${p.group.name} · ${f}</p>`;
        });
        cards += `<section>
            <h2>${s.name}</h2>
            ${lista}
            <a class="btn delay" href="/rotacion?key=${k}&accion=atrasar&cual=${alias}">Retrasar 1 semana</a>
            <a class="btn skip" href="/rotacion?key=${k}&accion=saltar&cual=${alias}">Saltar al siguiente</a>
        </section>`;
    });
    const banner = aviso ? `<div class="ok">${aviso.replace(/\n/g, '<br>').replace(/\*/g, '')}</div>` : '';
    const html = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rotación</title>
<style>
body{font-family:sans-serif;background:#0b141a;color:#e9edef;margin:0;padding:16px}
h1{font-size:1.3rem;margin:0 0 16px}
h2{font-size:1.05rem;margin:0 0 8px;color:#00a884}
section{background:#1f2c33;border-radius:12px;padding:16px;margin-bottom:16px}
.next{font-size:1.05rem;margin:0 0 8px}
.later{margin:4px 0;color:#8696a0;font-size:.9rem}
.btn{display:block;text-align:center;text-decoration:none;color:#fff;border-radius:8px;padding:14px;margin-top:10px;font-weight:700}
.delay{background:#f0b429}
.skip{background:#00a884}
.ok{background:#005c4b;padding:12px;border-radius:8px;margin-bottom:16px;white-space:pre-wrap}
</style></head>
<body>
<h1>Rotación</h1>
${banner}
${cards}
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
}

startBot();

process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (err) => console.error('No capturado:', err.message));
process.on('unhandledRejection', (err) => console.error('Rechazo:', err.message));
