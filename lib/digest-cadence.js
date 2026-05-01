// Phase F: pure helper that returns the next digest fire time after `now`.
// Two daily fires per recipient at 08:00 and 17:00 Atlantic/Canary,
// strictly greater than `now` (an exact-on-the-hour `now` advances to the
// next slot).
//
// We use Intl.DateTimeFormat to read the wall-clock hour in Atlantic/Canary,
// which handles DST automatically — the alternative (offset arithmetic) is
// fragile around the spring/fall transition days.

export const DIGEST_FIRE_HOURS_LOCAL = [8, 17];
export const DIGEST_FIRE_TZ = 'Atlantic/Canary';

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: DIGEST_FIRE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function partsAt(date) {
  const parts = Object.fromEntries(FMT.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// Given a target wall-clock time in DIGEST_FIRE_TZ (yyyy-mm-dd HH:00:00),
// return the corresponding UTC Date. We pick a UTC instant whose Canary
// wall-clock is the requested instant by iteratively correcting drift —
// converges in 1-2 passes outside DST transitions, 2-3 inside them.
function utcForLocal(year, month, day, hour) {
  let naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let pass = 0; pass < 4; pass++) {
    const probe = new Date(naive);
    const p = partsAt(probe);
    const probeWallMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const targetWallMs = Date.UTC(year, month - 1, day, hour, 0, 0);
    const drift = targetWallMs - probeWallMs;
    if (drift === 0) return probe;
    naive += drift;
  }
  return new Date(naive);
}

export function nextDigestFire(now) {
  const p = partsAt(now);
  for (const h of DIGEST_FIRE_HOURS_LOCAL) {
    const candidate = utcForLocal(p.year, p.month, p.day, h);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  // No fire left today — first fire of tomorrow.
  // Add 24h then re-read parts (handles month/year/DST rollover).
  const tomorrowProbe = new Date(now.getTime() + 24 * 3_600_000);
  const t = partsAt(tomorrowProbe);
  return utcForLocal(t.year, t.month, t.day, DIGEST_FIRE_HOURS_LOCAL[0]);
}
