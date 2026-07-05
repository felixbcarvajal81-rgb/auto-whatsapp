const config = require('./config.json');

function getProximoViernes() {
    const now = new Date();
    const dia = now.getDay();
    const diff = dia <= 5 ? 5 - dia : 6 + (5 - dia);
    const viernes = new Date(now);
    viernes.setDate(now.getDate() + diff);
    viernes.setHours(0, 0, 0, 0);
    return viernes;
}

function getMinisterioSemana() {
    const startDate = new Date(config.rotationStartDate);
    const targetFriday = getProximoViernes();
    const diffMs = targetFriday - startDate;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const weeksSinceStart = Math.floor(diffDays / 7);
    const index = weeksSinceStart % config.ministries.length;
    return config.ministries[index];
}

module.exports = { getMinisterioSemana, getProximoViernes };
