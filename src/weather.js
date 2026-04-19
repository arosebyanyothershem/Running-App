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
    'cloud_cover',
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
    cloudsPct: data.hourly.cloud_cover ? data.hourly.cloud_cover[i] : null,
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
// Calibrated against a 6-source publication consensus (Nike, Peloton, NYRR,
// Marathon Handbook, RVCA, Runner's World) cross-checked against 15 real-world
// dressmyrun.com data points and refined with Tina Muir's 5°F-interval guide.
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
// Returns { items, effectiveTempF, band, bias } so the UI can attribute feedback
// to the right band and explain the effective temperature.
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

  // Rain adjustment: per Tina Muir, Andrea Ference, Running Shoes Guru consensus,
  // wet clothing cools the body significantly. Dress for ~7°F cooler when rain is
  // likely (midpoint of the publication-agreed 5–10°F range).
  const precipPct = weather.precipPct || 0;
  const precipIn = weather.precipIn || 0;
  const rainAdjustment = precipPct >= 40 ? -7 : 0;

  let effTemp = weather.feelsLikeF + bias + rainAdjustment;

  const wind = weather.windMph || 0;
  const uv = weather.uv || 0;
  const cloudsPct = weather.cloudsPct;
  const heavyRain = precipIn > 0.05;
  const willRain = precipPct >= 40;
  const items = { top: [], bottom: [], head: [], hands: [], extras: [] };

  // ============ TOP ============
  // Sources: Tina Muir, dressmyrun, publication consensus
  if (effTemp >= 90) {
    items.top.push('Tank or singlet (lightweight, moisture-wicking)');
  } else if (effTemp >= 80) {
    items.top.push('Tank or singlet (lightweight, moisture-wicking)');
  } else if (effTemp >= 65) {
    items.top.push('Technical T-shirt or tank (personal preference)');
  } else if (effTemp >= 55) {
    items.top.push('Technical T-shirt');
  } else if (effTemp >= 45) {
    items.top.push('Long-sleeve or T-shirt (personal preference)');
  } else if (effTemp >= 40) {
    items.top.push('Long-sleeve technical shirt');
  } else if (effTemp >= 32) {
    items.top.push('Long-sleeve base layer (add light jacket or vest if windy)');
  } else if (effTemp >= 25) {
    items.top.push('Long-sleeve base + thicker mid-layer or wind jacket');
  } else if (effTemp >= 15) {
    items.top.push('Long-sleeve base layer + windproof/waterproof jacket');
  } else {
    items.top.push('Two long-sleeve layers + heavy insulated wind jacket');
  }

  // ============ BOTTOM ============
  if (effTemp >= 55) {
    items.bottom.push('Shorts (technical, with built-in liner)');
  } else if (effTemp >= 45) {
    items.bottom.push('Shorts (or half-tights if you run cold)');
  } else if (effTemp >= 40) {
    items.bottom.push('Half-tights or tights');
  } else if (effTemp >= 32) {
    items.bottom.push('Running tights');
  } else if (effTemp >= 15) {
    items.bottom.push('Thermal running tights');
  } else {
    items.bottom.push('Thermal tights with wind pants layered over');
  }

  // ============ HANDS ============
  if (effTemp < 20) {
    items.hands.push('Mittens (waterproof for precipitation)');
  } else if (effTemp < 32) {
    items.hands.push('Running gloves');
  } else if (effTemp < 40) {
    items.hands.push('Light running gloves');
  } else if (effTemp < 45) {
    items.hands.push('Light gloves (optional, for first mile)');
  }

  // ============ HEAD ============
  // Cap rule: UV ≥ 3, OR precip ≥ 20%, OR (cold AND not fully overcast)
  // Beanie rule: graduated by temperature per Tina Muir
  const lowClouds = cloudsPct === null || cloudsPct === undefined || cloudsPct < 80;
  const needsCap = uv >= 3 || precipPct >= 20 || (effTemp <= 40 && lowClouds);

  if (effTemp < 20) {
    items.head.push('Thick beanie with neck gaiter or buff');
  } else if (effTemp < 25) {
    items.head.push('Beanie covering ears');
  } else if (effTemp < 32) {
    items.head.push('Fleece headband or light beanie');
  } else if (effTemp < 40) {
    items.head.push('Light headband (optional)');
  }
  // Cap can coexist with beanie in cold/rainy conditions — they serve different purposes
  if (needsCap && effTemp >= 25) {
    const capReason = precipPct >= 20 ? 'keeps rain out of eyes' : 'sun and sweat protection';
    items.head.push(`Cap or visor (${capReason})`);
  }

  // ============ ACCESSORIES / EXTRAS ============
  // Sunglasses: (clear skies OR UV ≥ 3) AND not raining
  const clearSkies = cloudsPct !== null && cloudsPct !== undefined && cloudsPct < 40;
  if ((clearSkies || uv >= 3) && precipPct < 20) {
    items.extras.push('Sunglasses for sun protection');
  }

  // Rain-specific extras
  if (willRain) {
    if (heavyRain) {
      items.extras.push('Water-resistant running jacket (or consider postponing if rain is intense)');
    } else {
      items.extras.push('Water-resistant shell recommended — dressed for 7°F cooler to account for wet clothing');
    }
  }

  // Wind callout (feels-like already accounts for wind chill, but high winds deserve mention)
  if (wind >= 20) {
    items.extras.push(`Wind ${Math.round(wind)} mph — run into the wind first, with it on the way back`);
  }

  // Heat warnings
  if (effTemp >= 85 && effTemp < 90) {
    items.extras.push('Hydrate well; consider running in the cooler hours of the day');
  }
  if (effTemp >= 90) {
    items.extras.push('Heat illness risk — strongly consider rescheduling, running indoors, or choosing early morning / evening');
  }

  // Frostbite warning
  if (effTemp < 20) {
    items.extras.push('Cover exposed skin — frostbite risk in sub-freezing conditions with any wind');
  }

  return { items, effectiveTempF: Math.round(effTemp), band, bias, rainAdjusted: rainAdjustment !== 0 };
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
