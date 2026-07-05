const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const config = require('./config.json');
const { getMinisterioSemana, getProximoViernes } = require('./rotation');

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
    // Descomenta para ver los IDs de grupos:
    // await listarGrupos();
    iniciarProgramador();
});

client.on('message', async (msg) => {
    if (config.comandosHabilitados && msg.body.toLowerCase() === '!proximo') {
        const ministerio = getMinisterioSemana();
        const viernes = getProximoViernes();
        const fecha = viernes.toLocaleDateString('es-ES', {
            weekday: 'long', day: 'numeric', month: 'long'
        });
        await client.sendMessage(msg.from,
            `📅 *Próximo viernes* (${fecha})\n\nDirigen: *${ministerio.label}*`);
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

function iniciarProgramador() {
    console.log(`Programador iniciado: miércoles 3:00 PM`);

    cron.schedule(config.cronExpresion, async () => {
        try {
            const ministerio = getMinisterioSemana();
            const viernes = getProximoViernes();
            const fecha = viernes.toLocaleDateString('es-ES', {
                weekday: 'long', day: 'numeric', month: 'long'
            });
            const mensaje = `🙏 *Recordatorio Semanal* 🙏\n\nRecuerda que este *viernes* (${fecha}) dirigen *${ministerio.label}*\n\n¡Prepárate para ministrar! 🕊️`;

            const imagePath = path.join(__dirname, ministerio.image);
            if (fs.existsSync(imagePath)) {
                const media = MessageMedia.fromFilePath(imagePath);
                await client.sendMessage(config.groupId, media, { caption: mensaje });
            } else {
                await client.sendMessage(config.groupId, mensaje);
            }
            console.log(`Notificación enviada: ${ministerio.name}`);
        } catch (err) {
            console.error('Error al enviar notificación:', err);
        }
    });
}
