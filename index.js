const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('./config.json');
const { getGrupoSemana, getProximoDia } = require('./rotation');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot running');
});
server.listen(PORT, () => console.log(`Health check en puerto ${PORT}`));

// Limpiar caché pero conservar sesión si existe
const cachePath = path.join(__dirname, '.wwebjs_cache');
if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { recursive: true, force: true });

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        handleSIGINT: false,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-webgl',
            '--js-flags=--max-old-space-size=256'
        ]
    }
});

client.on('qr', async (qr) => {
    try {
        const now = new Date().toLocaleTimeString();
        const dataUrl = await QRCode.toDataURL(qr, { width: 200, margin: 1 });
        console.error(`[${now}] QR NUEVO - copia y pega en navegador:`);
        console.error(dataUrl);
    } catch (err) {
        console.error('Error QR:', err);
    }
});

client.on('auth_failure', (msg) => {
    console.error('Error de autenticación:', msg);
});

client.on('disconnected', async (reason) => {
    console.log('Desconectado:', reason);
    setTimeout(() => client.initialize(), 5000);
});

client.on('ready', async () => {
    console.error('=== CONECTADO A WHATSAPP ===');

    config.schedules.forEach(s => {
        if (s.active) {
            try {
                iniciarProgramador(s);
            } catch (e) {
                console.error(`Error en programador ${s.name}:`, e.message);
            }
        }
    });

    try {
        await client.sendMessage(config.groupId, '✅ Bot iniciado y listo');
    } catch (err) {
        console.error('ERROR mensaje prueba:', err.message);
    }
});

client.on('message', (msg) => {
    console.error(`EVENTO message: from=${msg.from}, body=${msg.body}`);
    procesarMensaje(msg);
});

client.on('message_create', (msg) => {
    procesarMensaje(msg);
});

async function procesarMensaje(msg) {
    try {
        if (!msg.body) return;
        console.error(`PROCESANDO: ${msg.body}`);
        if (!config.comandosHabilitados) return;

        if (msg.body.toLowerCase() === '!proximo') {
            let respuesta = '📅 *Próximos eventos*\n\n';
            config.schedules.forEach(s => {
                if (!s.active) return;
                const grupo = getGrupoSemana(s);
                const target = getProximoDia(s.targetDay);
                const fecha = target.toLocaleDateString('es-ES', {
                    weekday: 'long', day: 'numeric', month: 'long'
                });
                const diaSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][s.targetDay];
                respuesta += `▸ *${diaSemana}* (${fecha}): ${grupo.label}\n`;
            });
            const destino = msg.fromMe ? config.groupId : msg.from;
            await client.sendMessage(destino, respuesta);
            console.error(`Respuesta enviada a ${destino}`);
            return;
        }

        if (msg.body.toLowerCase() === '!grupos') {
            const chats = await client.getChats();
            const grupos = chats.filter(c => c.isGroup);
            let lista = '📋 *Grupos del bot*\n\n';
            grupos.forEach(g => {
                lista += `▸ ${g.name}\n  ID: ${g.id._serialized}\n\n`;
            });
            const destino = msg.fromMe ? config.groupId : msg.from;
            await client.sendMessage(destino, lista);
        }
    } catch (err) {
        console.error('Error en mensaje:', err);
    }
}

client.initialize();

process.on('SIGINT', async () => {
    console.log('\nCerrando sesión...');
    await client.destroy();
    process.exit(0);
});

function iniciarProgramador(schedule) {
    const diaSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][schedule.targetDay];
    console.log(`Programador: ${schedule.name} → ${schedule.cron}`);

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
                    const media = MessageMedia.fromFilePath(imagePath);
                    await client.sendMessage(config.groupId, media, { caption: mensaje });
                } else {
                    await client.sendMessage(config.groupId, mensaje);
                }
            } else {
                await client.sendMessage(config.groupId, mensaje);
            }
            console.log(`[${schedule.name}] Enviado: ${grupo.name}`);
        } catch (err) {
            console.error(`[${schedule.name}] Error:`, err);
        }
    });
}
