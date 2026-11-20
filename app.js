'use strict';
const element = id => document.getElementById(id);
const audio = element('audio');
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
let stations = [];
let current = 0;
let favourites = new Set(read('radio-favourites', []));
let favouritesOnly = false;
let wanted = false;
let sequence = 0;
let deadline;
let hls;
let sleepUntil = 0;
const failed = new Set();
const failureTimes = read('radio-failures', {});
let retryAttempt = 0;
let recoveryTimer;
let category = 'all';
let playing = false;
function showTrack(title, artist = '') {
  if (!wanted || !title) return;
  element('track').textContent = 'Now playing · ' + [artist, title].filter(Boolean).join(' — ');
  element('track').hidden = false;
  document.title = title + ' • ' + stations[current].name;
  if ('mediaSession' in navigator && window.MediaMetadata) {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: artist || stations[current].name, album: 'Bollywood Radio', artwork: [{ src: new URL('cover.jpg', location.href).href }] });
  }
}
function id3Track(bytes) {
  const result = {};
  if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3' || ![3, 4].includes(bytes[3]) || (bytes[5] & 0xc0)) return result;
  let offset = 10;
  while (offset + 10 <= bytes.length) {
    const key = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = bytes[3] === 4
      ? (bytes[offset + 4] & 127) * 2097152 + (bytes[offset + 5] & 127) * 16384 + (bytes[offset + 6] & 127) * 128 + (bytes[offset + 7] & 127)
      : bytes[offset + 4] * 16777216 + bytes[offset + 5] * 65536 + bytes[offset + 6] * 256 + bytes[offset + 7];
    if (!size || offset + 10 + size > bytes.length) break;
    if (['TIT2', 'TPE1'].includes(key) && bytes[offset + 8] === 0 && bytes[offset + 9] === 0) {
      const encoding = ['windows-1252', 'utf-16', 'utf-16be', 'utf-8'][bytes[offset + 10]];
      if (encoding) result[key] = new TextDecoder(encoding).decode(bytes.slice(offset + 11, offset + 10 + size)).replaceAll('\u0000', '').trim();
    }
    offset += size + 10;
  }
  return result;
}
audio.textTracks.addEventListener('addtrack', event => {
  const track = event.track;
  if (track.kind !== 'metadata') return;
  track.mode = 'hidden';
  track.addEventListener('cuechange', () => {
    for (const cue of track.activeCues || []) {
      const value = cue.value;
      if (value?.key === 'TIT2' && typeof value.data === 'string') showTrack(value.data);
    }
  });
});
function unavailable(url) {
  const timestamp = Number(failureTimes[url]);
  return Number.isFinite(timestamp) && Date.now() - timestamp < 300000;
}
function stationCategory(name) {
  if (/90|2000|60s/i.test(name)) return 'Decades';
  if (/Kumar Sanu|Mukesh|Rafi|Mohammed Aziz/i.test(name)) return 'Artists';
  if (/Love|Sad|Remix/i.test(name)) return 'Mood';
  return 'Other';
}
function render() {
  const station = stations[current];
  if (station) {
    element('title').textContent = station.name;
    const marked = favourites.has(station.url);
    element('favourite').textContent = marked ? '♥' : '♡';
    element('favourite').setAttribute('aria-pressed', String(marked));
    element('favourite').setAttribute('aria-label', marked ? 'Remove from favourites' : 'Add to favourites');
  }
  element('play').dataset.playing = String(wanted);
  element('play').setAttribute('aria-label', wanted ? 'Pause' : 'Play');
  const list = element('list');
  list.replaceChildren();
  let group = '';
  const query = element('search').value.toLowerCase();
  stations.forEach((item, index) => {
    if (!item.name.toLowerCase().includes(query) || (favouritesOnly && !favourites.has(item.url)) || (category !== 'all' && stationCategory(item.name) !== category)) return;
    const letter = /^\d/.test(item.name) ? '0–9' : item.name[0].toUpperCase();
    if (letter !== group) {
      const heading = document.createElement('h3');
      heading.textContent = group = letter;
      list.append(heading);
    }
    const row = document.createElement('div');
    row.className = 'station';
    const button = document.createElement('button');
    button.textContent = item.name;
    const badge = document.createElement('small');
    badge.className = 'station-status';
    badge.dataset.state = unavailable(item.url) ? 'failed' : index === current && playing ? 'playing' : 'unknown';
    badge.textContent = unavailable(item.url) ? 'Temporarily unavailable' : index === current && playing ? 'Playing on this device' : 'Not currently verified';
    button.append(badge);
    if (index === current) button.className = 'active';
    button.onclick = () => { element('drawer').close(); start(index); };
    const star = document.createElement('button');
    star.className = 'star';
    star.textContent = favourites.has(item.url) ? '♥' : '♡';
    star.setAttribute('aria-label', 'Toggle favourite for ' + item.name);
    star.setAttribute('aria-pressed', String(favourites.has(item.url)));
    star.onclick = () => toggleFavourite(item.url);
    row.append(button, star);
    list.append(row);
  });
  if (!list.childElementCount) list.textContent = 'No matching stations.';
}
function toggleFavourite(url) {
  if (!url) return;
  if (favourites.has(url)) favourites.delete(url); else favourites.add(url);
  save('radio-favourites', [...favourites]);
  render();
}
function pause() {
  wanted = false;
  playing = false;
  clearTimeout(recoveryTimer);
  sequence++;
  clearTimeout(deadline);
  audio.pause();
  document.title = 'Bollywood Radio — Listen to Hindi Radio Online';
  element('status').textContent = 'Paused';
  render();
}
function move(direction) {
  for (let step = 1; step <= stations.length; step++) {
    const index = (current + direction * step + stations.length) % stations.length;
    if (!unavailable(stations[index].url)) { start(index); return; }
  }
  pause();
  element('status').textContent = 'No stations could play. Use Retry stations to try again.';
}
function skip(token) {
  if (token !== sequence || !wanted) return;
  clearTimeout(deadline);
  audio.onerror = null;
  audio.onended = null;
  audio.onwaiting = null;
  audio.pause();
  playing = false;
  render();
  if (!navigator.onLine) {
    pause();
    element('status').textContent = 'You are offline. Reconnect, then press play.';
    return;
  }
  if (retryAttempt < 1) {
    element('status').textContent = 'Connection interrupted. Retrying station…';
    recoveryTimer = setTimeout(() => { if (token === sequence && wanted) start(current, 1); }, 1500);
    return;
  }
  failed.add(stations[current].url);
  failureTimes[stations[current].url] = Date.now();
  save('radio-failures', failureTimes);
  element('status').textContent = 'Station unavailable—trying next…';
  recoveryTimer = setTimeout(() => { if (token === sequence && wanted) move(1); }, 1500);
}
async function start(index, attempt = 0) {
  if (!stations.length) return;
  clearTimeout(deadline);
  clearTimeout(recoveryTimer);
  retryAttempt = attempt;
  element('track').hidden = true;
  element('track').textContent = '';
  playing = false;
  const token = ++sequence;
  wanted = true;
  current = index;
  audio.pause();
  audio.onplaying = null;
  audio.onwaiting = null;
  audio.onerror = null;
  audio.onended = null;
  if (hls) { hls.destroy(); hls = null; }
  audio.removeAttribute('src');
  audio.load();
  const station = stations[index];
  save('radio-last', station.url);
  element('status').textContent = 'Connecting…';
  render();
  audio.onplaying = () => {
    if (token !== sequence || !wanted) return;
    clearTimeout(deadline);
    playing = true;
    delete failureTimes[station.url];
    save('radio-failures', failureTimes);
    document.title = station.name + ' • Bollywood Radio';
    render();
    element('status').textContent = 'Playing live';
  };
  const armTimeout = () => {
    if (token !== sequence || !wanted) return;
    playing = false;
    element('status').textContent = 'Buffering…';
    render();
    clearTimeout(deadline);
    deadline = setTimeout(() => skip(token), 15000);
  };
  audio.onwaiting = armTimeout;
  audio.onerror = () => skip(token);
  audio.onended = () => skip(token);
  armTimeout();
  let url = station.url;
  if (url.startsWith('http:')) url = url.replace('http:', 'https:');
  if (url.includes('.m3u8') && !audio.canPlayType('application/vnd.apple.mpegurl') && window.Hls?.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.FRAG_PARSING_METADATA, (_event, data) => {
      if (token !== sequence || !wanted) return;
      for (const sample of data.samples || []) {
        const metadata = id3Track(sample.data);
        if (metadata.TIT2) showTrack(metadata.TIT2, metadata.TPE1);
      }
    });
    hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) skip(token); });
    hls.loadSource(url);
    hls.attachMedia(audio);
  } else audio.src = url;
  try {
    await audio.play();
    if (token !== sequence || !wanted) return;
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: station.name, artist: 'Bollywood Radio', artwork: [{ src: new URL('cover.jpg', location.href).href, type: 'image/jpeg' }] });
    }
  } catch (error) {
    if (token !== sequence) return;
    if (error.name === 'NotAllowedError') {
      pause();
      element('status').textContent = 'Press play to start listening';
    } else if (error.name !== 'AbortError') skip(token);
  }
}
element('play').onclick = () => wanted ? pause() : start(current);
element('next').onclick = () => move(1);
element('previous').onclick = () => move(-1);
element('favourite').onclick = () => toggleFavourite(stations[current]?.url);
element('browse').onclick = () => { element('drawer').showModal(); element('search').focus(); };
element('close').onclick = () => element('drawer').close();
element('search').oninput = render;
element('category').onchange = event => { category = event.target.value; render(); };
element('retry').onclick = () => {
  for (const url of Object.keys(failureTimes)) delete failureTimes[url];
  failed.clear();
  save('radio-failures', failureTimes);
  start(current);
};
element('share').onclick = async () => {
  const url = 'https://qaatwar.github.io/bollywood-radio/';
  try {
    if (navigator.share) await navigator.share({ title: 'Bollywood Radio', text: 'Stations for Music Lovers', url });
    else { await navigator.clipboard.writeText(url); element('status').textContent = 'Website link copied'; }
  } catch (error) {
    if (error.name !== 'AbortError') {
      element('share-link').hidden = false;
      element('status').textContent = 'Copy the website link below';
    }
  }
};
document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || element('drawer').open || event.target.closest('input,select,textarea,button,a,[contenteditable]')) return;
  if (event.code === 'Space') { event.preventDefault(); element('play').click(); }
  if (event.code === 'ArrowRight') { event.preventDefault(); move(1); }
  if (event.code === 'ArrowLeft') { event.preventDefault(); move(-1); }
});
window.addEventListener('offline', () => {
  if (wanted) { pause(); element('status').textContent = 'You are offline. Reconnect, then press play.'; }
});
element('only').onclick = () => {
  favouritesOnly = !favouritesOnly;
  element('only').setAttribute('aria-pressed', String(favouritesOnly));
  render();
};
const savedVolume = Number(read('radio-volume', .8));
audio.volume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(1, savedVolume)) : .8;
element('volume').value = audio.volume;
element('volume').oninput = event => { audio.volume = Number(event.target.value); save('radio-volume', audio.volume); };
element('sleep').onchange = event => {
  sleepUntil = Number(event.target.value) ? Date.now() + Number(event.target.value) * 60000 : 0;
  updateTimer();
};
function updateTimer() {
  if (sleepUntil && Date.now() >= sleepUntil) {
    pause();
    sleepUntil = 0;
    element('sleep').value = '0';
    element('status').textContent = 'Sleep timer finished';
  }
  element('timer').textContent = sleepUntil ? Math.ceil((sleepUntil - Date.now()) / 60000) + ' min remaining' : '';
}
setInterval(updateTimer, 1000);
document.addEventListener('visibilitychange', updateTimer);
if ('mediaSession' in navigator) {
  for (const [action, handler] of Object.entries({ play: () => start(current), pause, nexttrack: () => move(1), previoustrack: () => move(-1) })) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
  }
}
fetch('bollywood-radio.m3u', { cache: 'no-cache' }).then(response => {
  if (!response.ok) throw new Error('Playlist unavailable');
  return response.text();
}).then(text => {
  let name = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXTINF:')) name = line.slice(line.indexOf(',') + 1).trim();
    else if (/^https?:\/\//.test(line.trim()) && name) {
      stations.push({ name, url: line.trim() });
      name = '';
    }
  }
  stations = stations.filter((station, index, all) => all.findIndex(item => item.url === station.url) === index).sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }));
  if (!stations.length) throw new Error('Empty playlist');
  current = Math.max(0, stations.findIndex(item => item.url === read('radio-last', '')));
  element('status').textContent = 'Press play to start listening';
  render();
}).catch(() => {
  element('title').textContent = 'Station list unavailable';
  element('status').textContent = location.protocol === 'file:' ? 'Open the GitHub Pages website to load stations.' : 'Please reload in a moment.';
});
let installPrompt;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  element('install').hidden = false;
});
element('install').onclick = async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    installPrompt = null;
    element('install').hidden = true;
  }
};
window.addEventListener('appinstalled', () => { element('install').hidden = true; });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
