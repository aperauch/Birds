// Sunrise/sunset for a calendar date + coordinates, via NOAA's public-domain
// solar-position equations (https://gml.noaa.gov/grad/solcalc/solareqns.PDF).
// Accurate to roughly a minute — plenty for a "dawn chorus vs sunrise" overlay.
// Pure and dependency-free so it runs on workerd with no WASM/native deps.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function normalizeDeg(d: number): number {
  const x = d % 360;
  return x < 0 ? x + 360 : x;
}

/** Julian day number at 0h UT for a Gregorian calendar date. */
function julianDay(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + B - 1524.5;
}

export interface SunTimes {
  sunrise: number; // unix seconds (UTC)
  sunset: number;
}

/**
 * Sunrise/sunset (UTC unix seconds) for a calendar date at (lat, lon) in
 * degrees (lon negative = west, matching the NOAA convention). Returns null
 * for polar day/night — not expected at continental-US latitudes, but the
 * formula is general.
 */
export function sunTimes(date: string, lat: number, lon: number): SunTimes | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;

  // T is computed at ~solar noon UT; a day's worth of drift in T is negligible
  // for sunrise/sunset (this is the standard NOAA simplification).
  const jd = julianDay(year, month, day) + 0.5;
  const T = (jd - 2451545) / 36525;

  const L0 = normalizeDeg(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const obliqSeconds = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
  const meanObliq = 23 + (26 + obliqSeconds / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega * RAD);

  const dec = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(lambda * RAD)) * DEG;

  const y = Math.pow(Math.tan((obliqCorr / 2) * RAD), 2);
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));

  // 90.833deg accounts for atmospheric refraction + the sun's apparent radius.
  const haCos =
    Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(dec * RAD)) -
    Math.tan(lat * RAD) * Math.tan(dec * RAD);
  if (haCos < -1 || haCos > 1) return null; // polar day (< -1) or polar night (> 1)
  const ha = Math.acos(haCos) * DEG;

  const solarNoonFrac = (720 - 4 * lon - eqTime) / 1440; // fraction of the UTC day
  const sunriseFrac = solarNoonFrac - (ha * 4) / 1440;
  const sunsetFrac = solarNoonFrac + (ha * 4) / 1440;

  const UNIX_EPOCH_JD = 2440587.5;
  const dayStartUnix = Math.round((jd - 0.5 - UNIX_EPOCH_JD) * 86400); // midnight UT of `date`
  return {
    sunrise: dayStartUnix + Math.round(sunriseFrac * 86400),
    sunset: dayStartUnix + Math.round(sunsetFrac * 86400),
  };
}
