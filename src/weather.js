// Weather service: geocode US ZIP codes and fetch forecasts from Open-Meteo

// US ZIP geocoding via Zippopotam (free, no key needed)
export async function geocodeZip(zip) {
  const cleaned = String(zip).trim().replace(/\D/g, '').slice(0, 5);
  if (cleaned.length !== 5) {
    throw new Error('Please enter a 5-digit US ZIP code.');
  }
  const res = await fetch(`https://api.zippopotam.us/us/${cleaned}`);
  if (!res.ok) throw new Error('ZIP not found.');
  const data = await res.json();
  const place = data.places && data.places[0];
  if (!place) throw new Error('No location for that ZIP.');
  return {
    zip: cleaned,
    lat: parseFloat(place.latitude),
    lon: parseFloat(place.longitude),
    city: place['place name'],
    state: place['state abbreviation'],
  };
}

// Fetch hourly forecast from Open-Meteo for a given lat/lon and date
// Returns array of hourly snapshots
export async function fetchForecast(lat, lon, dateISO) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('hourly', [
    'temperature_2m',
    'apparent_temperature',
    'precipitation_probability',
    'precipitation',
    'weather_code',
    'wind_speed_10m',
    'wind_direction_10m',
    'relative_humidity_2m',
    'uv_index',
  ].join(','));
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', dateISO);
  url.searchParams.set('end_date', dateISO);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Could not fetch weather.');
  const data = await res.json();

  // Reshape into per-hour objects
  const hours = data.hourly.time.map((t, i) => ({
    time: t,
    tempF: data.hourly.temperature_2m[i],
    feelsLikeF: data.hourly.apparent_temperature[i],
    precipPct: data.hourly.precipitation_probability[i],
    precipIn: data.hourly.precipitation[i],
    weatherCode: data.hourly.weather_code[i],
    windMph: data.hourly.wind_speed_10m[i],
    windDeg: data.hourly.wind_direction_10m[i],
    humidity: data.hourly.relative_humidity_2m[i],
    uv: data.hourly.uv_index ? data.hourly.uv_index[i] : null,
  }));

  return hours;
}

// Find the hour closest to a given target hour (0-23)
export function pickHour(hours, targetHour) {
  if (!hours || hours.length === 0) return null;
  // Find an hour matching the target hour
  const match = hours.find(h => {
    const hr = parseInt(h.time.slice(11, 13), 10);
    return hr === targetHour;
  });
  return match || hours[0];
}

// WMO weather code to a friendly description + emoji
const WEATHER_CODES = {
  0: { desc: 'Clear', icon: '☀️' },
  1: { desc: 'Mostly clear', icon: '🌤️' },
  2: { desc: 'Partly cloudy', icon: '⛅' },
  3: { desc: 'Overcast', icon: '☁️' },
  45: { desc: 'Fog', icon: '🌫️' },
  48: { desc: 'Freezing fog', icon: '🌫️' },
  51: { desc: 'Light drizzle', icon: '🌦️' },
  53: { desc: 'Drizzle', icon: '🌦️' },
  55: { desc: 'Heavy drizzle', icon: '🌧️' },
  61: { desc: 'Light rain', icon: '🌧️' },
  63: { desc: 'Rain', icon: '🌧️' },
  65: { desc: 'Heavy rain', icon: '🌧️' },
  71: { desc: 'Light snow', icon: '🌨️' },
  73: { desc: 'Snow', icon: '🌨️' },
  75: { desc: 'Heavy snow', icon: '❄️' },
  80: { desc: 'Rain showers', icon: '🌧️' },
  81: { desc: 'Heavy showers', icon: '🌧️' },
  82: { desc: 'Violent showers', icon: '⛈️' },
  95: { desc: 'Thunderstorm', icon: '⛈️' },
};

export function describeWeather(code) {
  return WEATHER_CODES[code] || { desc: 'Unknown', icon: '🌡️' };
}

// Compass direction from degrees
export function compassFromDeg(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// Outfit recommendations with banded warmth biases
//
// `biases` is an object: { cold, cool, warm, hot } where each value is a °F offset
// applied to the effective temp when the actual feels-like falls in that band:
//   cold band:  feels-like < 40°F
//   cool band:  40–60°F
//   warm band:  60–75°F
//   hot band:   > 75°F
// A NEGATIVE bias means "I run cold, dress me warmer" (effective temp drops)
// A POSITIVE bias means "I run hot, dress me cooler" (effective temp rises)
//
// Returns { items, effectiveTempF, band } so the UI can attribute feedback to the right band.
export function getBandForTemp(feelsLikeF) {
  if (feelsLikeF < 40) return 'cold';
  if (feelsLikeF < 60) return 'cool';
  if (feelsLikeF < 75) return 'warm';
  return 'hot';
}

export function recommendOutfit(weather, options = {}) {
  const { biases = { cold: 0, cool: 0, warm: 0, hot: 0 } } = options;
  if (!weather) return null;

  const band = getBandForTemp(weather.feelsLikeF);
  const bias = biases[band] || 0;
  let effTemp = weather.feelsLikeF + bias;

  const wind = weather.windMph || 0;
  const precip = weather.precipPct || 0;
  const willRain = precip >= 40;
  const heavyRain = (weather.precipIn || 0) > 0.05;
  const items = { top: [], bottom: [], head: [], hands: [], feet: [], extras: [] };

  // ============ TOP ============
  if (effTemp >= 75) {
    items.top.push('Singlet or technical T-shirt');
  } else if (effTemp >= 60) {
    items.top.push('Short-sleeve technical T-shirt');
  } else if (effTemp >= 50) {
    items.top.push('Long-sleeve base layer');
  } else if (effTemp >= 40) {
    items.top.push('Long-sleeve base layer + light long-sleeve over-shirt');
  } else if (effTemp >= 30) {
    items.top.push('Long-sleeve base layer + thermal mid-layer');
  } else if (effTemp >= 20) {
    items.top.push('Base layer + thermal mid-layer + wind/soft-shell jacket');
  } else if (effTemp >= 10) {
    items.top.push('Heavy base layer + thermal mid-layer + insulated jacket');
  } else {
    items.top.push('Multiple base layers + insulated winter running jacket');
  }

  // ============ BOTTOM ============
  if (effTemp >= 60) {
    items.bottom.push('Shorts');
  } else if (effTemp >= 45) {
    items.bottom.push('Shorts (legs warm fast) or capri tights');
  } else if (effTemp >= 30) {
    items.bottom.push('Running tights');
  } else if (effTemp >= 15) {
    items.bottom.push('Thermal running tights');
  } else {
    items.bottom.push('Thermal tights + wind-blocking pants');
  }

  // ============ HEAD ============
  if (effTemp < 30) {
    items.head.push('Beanie or thermal headband');
  } else if (effTemp < 45) {
    items.head.push('Light headband or beanie covering ears');
  } else if (effTemp >= 70) {
    items.head.push('Cap or visor (sun protection)');
  }

  // ============ HANDS ============
  if (effTemp < 25) {
    items.hands.push('Insulated gloves or mittens');
  } else if (effTemp < 40) {
    items.hands.push('Light running gloves');
  } else if (effTemp < 50) {
    items.hands.push('Light gloves (optional, for first mile)');
  }

  // ============ FEET ============
  if (effTemp < 30) {
    items.feet.push('Thermal/wool socks');
  } else if (effTemp < 50) {
    items.feet.push('Mid-weight socks');
  } else {
    items.feet.push('Standard running socks');
  }

  // ============ EXTRAS ============
  if (wind > 15 && effTemp < 50) {
    items.extras.push('Wind-blocking outer layer recommended');
  }
  if (wind > 20) {
    items.extras.push(`Wind ${Math.round(wind)} mph — run into the wind first, with it on the way back`);
  }
  if (willRain || heavyRain) {
    items.extras.push(heavyRain ? 'Water-resistant jacket or skip the run' : 'Light water-resistant shell or cap with brim');
  }
  if (effTemp < 30) {
    items.extras.push('Cover exposed skin — frostbite risk is real below freezing with wind');
  }
  if (effTemp >= 80) {
    items.extras.push('Bring water; consider running earlier or later for cooler temps');
  }
  if (effTemp >= 90) {
    items.extras.push('Strongly consider rescheduling — heat illness risk');
  }
  if (weather.uv && weather.uv >= 6) {
    items.extras.push('UV index high — sunscreen + hat');
  }

  return { items, effectiveTempF: Math.round(effTemp), band, bias };
}

// Apply user feedback to update the bias for the relevant temperature band.
// Returns updated biases object.
//
// Feedback magnitudes:
//   'way-too-cold' → -7°F shift (dress me much warmer)
//   'too-cold'     → -3°F shift (dress me a bit warmer)
//   'too-hot'      → +3°F shift (dress me a bit cooler)
//   'way-too-hot'  → +7°F shift (dress me much cooler)
//
// Caps each band's bias at ±20°F to prevent runaway from repeated taps.
export function applyFeedback(biases, band, feedback) {
  const shifts = {
    'way-too-cold': -7,
    'too-cold': -3,
    'too-hot': 3,
    'way-too-hot': 7,
  };
  const delta = shifts[feedback];
  if (delta === undefined) return biases;
  const current = biases[band] || 0;
  const next = Math.max(-20, Math.min(20, current + delta));
  return { ...biases, [band]: next };
}

export const EMPTY_BIASES = { cold: 0, cool: 0, warm: 0, hot: 0 };
