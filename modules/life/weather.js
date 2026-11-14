// Open-Meteo geocoding and forecast (pickPlace, weatherCodeLabel, the request shape) through the desk's fetch door. Times come back as UTC instants so the page shows them in the owner's zone.
const TZ_ALIASES = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu' };
const canonicalTz = (tz) => TZ_ALIASES[tz] || tz || '';
export function pickPlace(results, localTz) {
  if (!Array.isArray(results) || !results.length) return null;
  const tz = canonicalTz(localTz);
  return results.find((r) => tz && canonicalTz(r.timezone) === tz) || results[0];
}
export function weatherCodeLabel(code) {
  const n = Number(code);
  if (n === 0) return 'Clear'; if (n <= 2) return 'Partly cloudy'; if (n === 3) return 'Cloudy'; if (n <= 48) return 'Fog';
  if (n <= 57) return 'Drizzle'; if (n <= 67) return 'Rain'; if (n <= 77) return 'Snow'; if (n <= 82) return 'Showers'; if (n <= 86) return 'Snow showers'; if (n <= 99) return 'Thunderstorm';
  return 'Unknown';
}
export async function geocode(fetch, name, { count = 6 } = {}) {
  const place = String(name || '').trim();
  if (!place || place.length > 120) throw Object.assign(new Error('Give a city name.'), { status: 400 });
  const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
  u.searchParams.set('name', place); u.searchParams.set('count', String(count)); u.searchParams.set('language', 'en'); u.searchParams.set('format', 'json');
  const res = await fetch(u.href, { headers: { accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`The place search answered ${res.status}.`), { status: 502 });
  const data = await res.json();
  return (data.results || []).map(r => ({ name: r.name, label: [r.name, r.admin1, r.country].filter(Boolean).join(', '), lat: Number(r.latitude), lon: Number(r.longitude), timezone: r.timezone || null, country: r.country_code || null }));
}
export async function forecast(fetch, { lat, lon, label }) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', String(lat)); u.searchParams.set('longitude', String(lon));
  u.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation');
  u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset');
  u.searchParams.set('forecast_days', '7'); u.searchParams.set('timezone', 'auto'); u.searchParams.set('timeformat', 'unixtime');
  const res = await fetch(u.href, { headers: { accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`The forecast service answered ${res.status}.`), { status: 502 });
  const d = await res.json(); const c = d.current || {}; const dy = d.daily || {};
  const iso = (s) => (s != null ? new Date(Number(s) * 1000).toISOString() : null);
  return {
    place: label, lat, lon, placeTimeZone: d.timezone || null, source: 'Open-Meteo (open-meteo.com), keyless', fetchedAt: new Date().toISOString(),
    current: { at: iso(c.time), tempC: c.temperature_2m ?? null, feelsC: c.apparent_temperature ?? null, humidity: c.relative_humidity_2m ?? null, windKph: c.wind_speed_10m ?? null, rainMm: c.precipitation ?? null, weather: weatherCodeLabel(c.weather_code) },
    days: (dy.time || []).map((t, i) => ({ day: iso(t), weather: weatherCodeLabel(dy.weather_code?.[i]), maxC: dy.temperature_2m_max?.[i] ?? null, minC: dy.temperature_2m_min?.[i] ?? null, rainMm: dy.precipitation_sum?.[i] ?? null, rainChance: dy.precipitation_probability_max?.[i] ?? null, sunrise: iso(dy.sunrise?.[i]), sunset: iso(dy.sunset?.[i]) })),
  };
}
