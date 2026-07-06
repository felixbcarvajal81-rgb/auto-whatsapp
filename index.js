const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { toString: qrToString } = require('qrcode');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('./config.json');
const { getGrupoSemana, getProximoDia } = require('./rotation');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot running');
}).listen(PORT, () => console.log(`Health check en puerto ${PORT}`));

// Force fresh auth on every deploy
const authPath = path.join(__dirname, '.wwebjs_auth');
if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { recursive: true, force: true });
    console.log('Sesión anterior eliminada — escanea el QR nuevo');
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        handleSIGINT: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', async (qr) => {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║  ESCANEA EL QR CON TU WHATSAPP           ║');
    console.log('║  (Ajustes > Dispositivos vinculados)     ║');
    console.log('╚══════════════════════════════════════════╝');
    try {
        const qrText = await qrToString(qr, { type: 'terminal', small: true });
        console.log(qrText);
    } catch (e) {
        console.log('QR raw (copia el enlace en tu navegador):');
        console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    }
    console.log('╔══════════════════════════════════════════╗');
    console.log('║  ESCANEA EL QR DE ARRIBA                 ║');
    console.log('╚══════════════════════════════════════════╝');
});

client.on('auth_failure', (msg) => {
    console.error('Error de autenticación:', msg);
});

client.on('disconnected', async (reason) => {
    console.log('Desconectado:', reason);
    setTimeout(() => client.initialize(), 5000);
});

client.on('ready', async () => {
    console.clear();
    console.log('Conectado a WhatsApp');
    await listarGrupos();
    config.schedules.forEach(s => {
        if (s.active) iniciarProgramador(s);
    });

    // Prueba: enviar un mensaje al grupo al conectarse
    try {
        console.log(`Intentando enviar a: ${config.groupId}`);
        await client.sendMessage(config.groupId, '✅ Bot iniciado y listo');
        console.log('Mensaje de prueba enviado');
    } catch (err) {
        console.error('Error al enviar:', err.message);
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

async function listarGrupos() {
    console.log('Buscando grupos...');
    const chats = await client.getChats();
    const grupos = chats.filter(c => c.isGroup);
    console.log('\n--- GRUPOS ---');
    grupos.forEach(g => console.log(`${g.name}: ${g.id._serialized}`));
    console.log('---------------\n');
}

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
