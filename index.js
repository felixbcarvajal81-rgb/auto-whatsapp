const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
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

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        handleSIGINT: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.clear();
    console.log('▼ ESCANEA ESTE CÓDIGO CON TU CELULAR ▼\n');
    qrcode.generate(qr, { small: true });
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
    // await listarGrupos();
    config.schedules.forEach(s => {
        if (s.active) iniciarProgramador(s);
    });
});

client.on('message', async (msg) => {
    if (config.comandosHabilitados && msg.body.toLowerCase() === '!proximo') {
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
        await client.sendMessage(msg.from, respuesta);
        return;
    }
    if (config.comandosHabilitados && msg.body.toLowerCase() === '!grupos') {
        const chats = await client.getChats();
        const grupos = chats.filter(c => c.isGroup);
        let lista = '📋 *Grupos donde está el bot*\n\n';
        grupos.forEach(g => {
            lista += `▸ ${g.name}\n  ID: ${g.id._serialized}\n\n`;
        });
        await client.sendMessage(msg.from, lista);
    }
});

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
