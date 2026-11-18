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
function render() {
  const station = stations[current];
  if (station) {
    element('title').textContent = station.name;
    const marked = favourites.has(station.url);
    element('favourite').textContent = marked ? '♥' : '♡';
    element('favourite').setAttribute('aria-pressed', String(marked));
    element('favourite').setAttribute('aria-label', marked ? 'Remove from favourites' : 'Add to favourites');
  }
  element('play').textContent = wanted ? 'Ⅱ' : '▶';
  element('play').setAttribute('aria-label', wanted ? 'Pause' : 'Play');
  const list = element('list');
  list.replaceChildren();
  let group = '';
  const query = element('search').value.toLowerCase();
  stations.forEach((item, index) => {
    if (failed.has(item.url) || !item.name.toLowerCase().includes(query) || (favouritesOnly && !favourites.has(item.url))) return;
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
  sequence++;
  clearTimeout(deadline);
  audio.pause();
  element('status').textContent = 'Paused';
  render();
}
function move(direction) {
  for (let step = 1; step <= stations.length; step++) {
    const index = (current + direction * step + stations.length) % stations.length;
    if (!failed.has(stations[index].url)) { start(index); return; }
  }
  pause();
  element('status').textContent = 'No stations could play. Reload to try again.';
}
function skip(token) {
  if (token !== sequence || !wanted) return;
  failed.add(stations[current].url);
  move(1);
}
async function start(index) {
  if (!stations.length) return;
  clearTimeout(deadline);
  const token = ++sequence;
  wanted = true;
  current = index;
  audio.pause();
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
    element('status').textContent = 'Playing live';
  };
  const armTimeout = () => {
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
    hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) skip(token); });
    hls.loadSource(url);
    hls.attachMedia(audio);
  } else audio.src = url;
  try {
    await audio.play();
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
  navigator.mediaSession.setActionHandler('play', () => start(current));
  navigator.mediaSession.setActionHandler('pause', pause);
  navigator.mediaSession.setActionHandler('nexttrack', () => move(1));
  navigator.mediaSession.setActionHandler('previoustrack', () => move(-1));
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
  element('status').textContent = 'Please reload in a moment.';
});
