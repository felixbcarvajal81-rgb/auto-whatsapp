function getProximoDia(targetDay) {
    const now = new Date();
    const dia = now.getDay();
    const diff = ((targetDay - dia) + 7) % 7 || 7;
    const target = new Date(now);
    target.setDate(now.getDate() + diff);
    target.setHours(0, 0, 0, 0);
    return target;
}

function getGrupoSemana(schedule) {
    const startDate = new Date(schedule.rotationStartDate);
    const targetDate = getProximoDia(schedule.targetDay);
    const diffMs = targetDate - startDate;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const weeksSinceStart = Math.floor(diffDays / 7);
    const index = weeksSinceStart % schedule.groups.length;
    return schedule.groups[index];
}

module.exports = { getGrupoSemana, getProximoDia };
