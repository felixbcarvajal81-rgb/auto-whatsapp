function getProximoDia(targetDay) {
    const now = new Date();
    const dia = now.getDay();
    const diff = ((targetDay - dia) + 7) % 7 || 7;
    const target = new Date(now);
    target.setDate(now.getDate() + diff);
    target.setHours(0, 0, 0, 0);
    return target;
}

function indiceGrupo(schedule, targetDate) {
    const startDate = new Date(schedule.rotationStartDate);
    const diffDays = Math.floor((targetDate - startDate) / (1000 * 60 * 60 * 24));
    const n = schedule.groups.length;
    const weeks = Math.floor(diffDays / 7);
    return ((weeks % n) + n) % n;
}

function getGrupoSemana(schedule) {
    const targetDate = getProximoDia(schedule.targetDay);
    return schedule.groups[indiceGrupo(schedule, targetDate)];
}

function getGruposProximos(schedule, count = 4) {
    const first = getProximoDia(schedule.targetDay);
    const result = [];
    for (let i = 0; i < count; i++) {
        const target = new Date(first);
        target.setDate(first.getDate() + i * 7);
        result.push({ date: target, group: schedule.groups[indiceGrupo(schedule, target)] });
    }
    return result;
}

function shiftIsoDate(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function ajustarRotacion(schedule, semanas) {
    schedule.rotationStartDate = shiftIsoDate(schedule.rotationStartDate, semanas * 7);
    return schedule;
}

module.exports = { getGrupoSemana, getProximoDia, getGruposProximos, ajustarRotacion };
