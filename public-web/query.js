// Shared query/relay logic for index.html and it.html.
// Requires API_URL, DEFAULT_CRAWLER_URL, and LANG to be defined before this script.

(function initLangSwitch() {
  const params = window.location.search;
  const link = document.getElementById('langSwitchLink');
  if (link && params) link.href = LANG.langSwitchHref + params;
})();

document.getElementById('lastModified').textContent =
  LANG.lastModified +
  new Date(document.lastModified).toLocaleDateString(LANG.locale);

const CAT_COLORS = {
  music: '#7c3aed',
  food: '#d97706',
  sports: '#059669',
  art: '#db2777',
  theater: '#dc2626',
  film: '#2563eb',
  nightlife: '#9333ea',
  community: '#0891b2',
  outdoor: '#16a34a',
  learning: '#0d9488',
  wellness: '#65a30d',
  talks: '#ea580c',
  other: '#6b7280',
};
function catColor(cat) {
  return CAT_COLORS[cat] || CAT_COLORS.other;
}

(async function loadStats() {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    const pill = document.getElementById('eventCountPill');
    if (data.total_events != null) {
      pill.innerHTML = `<strong>${data.total_events}</strong> ${LANG.eventsInDb}`;
    } else {
      pill.textContent = LANG.discoverEvents;
    }
    if (data.last_event) {
      const e = data.last_event;
      const loc = e.venue_name || `${e.lat.toFixed(3)}, ${e.lng.toFixed(3)}`;
      const lastPill = document.getElementById('lastEventPill');
      lastPill.style.display = '';
      lastPill.textContent = LANG.latestEvent(e.title, loc);
    }
  } catch (_) {
    document.getElementById('eventCountPill').textContent = LANG.discoverEvents;
  }
})();

function handleTimeRangePresetChange() {
  const preset = document.getElementById('timeRangePreset').value;
  const customDiv = document.getElementById('customTimeRange');
  if (preset === 'custom') {
    customDiv.style.display = 'flex';
    const now = new Date();
    const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    document.getElementById('queryFromTime').value = now
      .toISOString()
      .slice(0, 16);
    document.getElementById('queryToTime').value = future
      .toISOString()
      .slice(0, 16);
  } else {
    customDiv.style.display = 'none';
  }
}

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
let _loadedEvents = [];
let _loadedMeta = {};

async function listEvents() {
  const address = document.getElementById('queryAddress').value.trim();
  const resultDiv = document.getElementById('geocodeResult');
  const coordsDisplay = document.getElementById('coordsDisplay');
  const feedback = document.getElementById('searchFeedback');
  const resultsSection = document.getElementById('resultsSection');

  resultsSection.hidden = true;
  resultDiv.innerHTML = '';

  if (address) {
    coordsDisplay.style.display = 'none';
    feedback.innerHTML = `<div class="loading">${LANG.geocodingAddress} <span class="spinner"></span></div>`;
    try {
      const geoResp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
        { headers: { 'User-Agent': 'Tokoro App' } }
      );
      const geoData = await geoResp.json();
      if (geoData && geoData.length > 0) {
        const loc = geoData[0];
        const lat = parseFloat(loc.lat).toFixed(4);
        const lng = parseFloat(loc.lon).toFixed(4);
        document.getElementById('queryLat').value = lat;
        document.getElementById('queryLng').value = lng;
        coordsDisplay.textContent = `${lat}, ${lng}`;
        coordsDisplay.style.display = '';
      } else {
        resultDiv.innerHTML = `<div class="status-error" style="margin-top:6px">${LANG.addressNotFound}</div>`;
        feedback.innerHTML = '';
        return;
      }
    } catch (err) {
      resultDiv.innerHTML = `<div class="status-error" style="margin-top:6px">${LANG.geocodingError(escHtml(err.message))}</div>`;
      feedback.innerHTML = '';
      return;
    }
  }

  const lat = document.getElementById('queryLat').value;
  const lng = document.getElementById('queryLng').value;
  const radius = document.getElementById('queryRadius').value;
  const category = document.getElementById('queryCategory').value;

  feedback.innerHTML = `<div class="loading">${LANG.searchingForEvents} <span class="spinner"></span></div>`;

  try {
    let fromTime, toTime;
    const preset = document.getElementById('timeRangePreset').value;
    if (preset === 'custom') {
      const fromInput = document.getElementById('queryFromTime').value;
      const toInput = document.getElementById('queryToTime').value;
      if (!fromInput || !toInput) {
        feedback.innerHTML = `<div class="status-error">${LANG.customRangeError}</div>`;
        return;
      }
      fromTime = fromInput + ':00';
      toTime = toInput + ':00';
    } else {
      const now = new Date();
      const future = new Date(
        now.getTime() + parseInt(preset) * 24 * 60 * 60 * 1000
      );
      fromTime = formatLocalDateTime(now);
      toTime = formatLocalDateTime(future);
    }

    let url = `${API_URL}/events?lat=${lat}&lng=${lng}&radius=${radius}&from=${fromTime}&to=${toTime}`;
    if (category) url += `&category=${category}`;

    const response = await fetch(url);
    const data = await response.json();
    feedback.innerHTML = '';
    _loadedMeta = { lat, lng, radius, category, fromTime, toTime, preset };

    if (data.events && data.events.length > 0) {
      _loadedEvents = data.events;
      const fmt = t =>
        new Date(t).toLocaleDateString(LANG.locale, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
      document.getElementById('resultsTitle').textContent = LANG.eventsFound(
        data.events.length
      );
      document.getElementById('resultsMeta').textContent =
        `${fmt(fromTime)} – ${fmt(toTime)} · ${LANG.within} ${radius} km`;
      const isMobile = window.innerWidth <= 640;
      const useColumns = !category && !isMobile;
      const { festivalItems, remainingEvents } = groupFestivals(data.events);
      const grouped = groupEvents(remainingEvents);
      const sortedGrouped = isMobile
        ? grouped
            .slice()
            .sort((a, b) =>
              a.event.start_time < b.event.start_time
                ? -1
                : a.event.start_time > b.event.start_time
                  ? 1
                  : 0
            )
        : grouped;
      const allItems = [...festivalItems, ...sortedGrouped];
      document.getElementById('eventsList').innerHTML = useColumns
        ? renderMagazine(fromTime, toTime, grouped, festivalItems)
        : `<div class="events-list">${renderItems(allItems, fromTime, toTime)}</div>`;
      resultsSection.hidden = false;
    } else {
      _loadedEvents = [];
      const fmt = t =>
        new Date(t).toLocaleDateString(LANG.locale, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
      feedback.innerHTML = `<div class="status-info">${LANG.noEventsFound(fmt(fromTime), fmt(toTime))}</div>`;
    }
  } catch (err) {
    feedback.innerHTML = `<div class="status-error">${LANG.searchError(escHtml(err.message))}</div>`;
  }
}

function effectiveDays(event, fromTime, toTime) {
  function dayStart(s) {
    const parts = String(s).split('T')[0].split('-');
    return new Date(
      parseInt(parts[0]),
      parseInt(parts[1]) - 1,
      parseInt(parts[2])
    );
  }
  const evStart = dayStart(event.start_time);
  const evEnd = event.end_time ? dayStart(event.end_time) : evStart;
  const winStart = dayStart(fromTime);
  const winEnd = dayStart(toTime);
  const overlapStart = evStart > winStart ? evStart : winStart;
  const overlapEnd = evEnd < winEnd ? evEnd : winEnd;
  if (overlapEnd < overlapStart) return 0;
  return Math.round((overlapEnd - overlapStart) / 86400000) + 1;
}

function todayTomorrowStrs() {
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d =>
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { todayStr: fmt(today), tomorrowStr: fmt(tomorrow) };
}

function weekendStrs() {
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d =>
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dow = today.getDay();
  const daysToSat = dow === 0 ? -1 : (6 - dow + 7) % 7;
  const daysToSun = (7 - dow) % 7;
  const sat = new Date(today);
  sat.setDate(today.getDate() + daysToSat);
  const sun = new Date(today);
  sun.setDate(today.getDate() + daysToSun);
  return { satStr: fmt(sat), sunStr: fmt(sun) };
}

function renderUrgencyPill(event, color, fromTime, toTime) {
  const { todayStr, tomorrowStr } = todayTomorrowStrs();
  const evDateStr = event.start_time.slice(0, 10);
  const ongoingToday =
    evDateStr <= todayStr &&
    (!event.end_time || event.end_time.slice(0, 10) >= todayStr);

  if (ongoingToday) {
    const hour = event.start_time.includes('T')
      ? parseInt(event.start_time.slice(11, 13))
      : 12;
    const label =
      evDateStr === todayStr && hour >= 17 ? LANG.tonight : LANG.today;
    return `<span class="urgency-pill urgency-pill--filled" style="background:${color}">${label}</span>`;
  }
  if (evDateStr === tomorrowStr) {
    return `<span class="urgency-pill urgency-pill--outlined" style="border-color:${color};color:${color}">${LANG.tomorrow}</span>`;
  }
  const { satStr, sunStr } = weekendStrs();
  if (evDateStr === satStr || evDateStr === sunStr) {
    return `<span class="urgency-pill urgency-pill--outlined" style="border-color:${color};color:${color}">${LANG.thisWeekend}</span>`;
  }
  const daysUntilStart = Math.round(
    (new Date(evDateStr) - new Date(todayStr)) / 86400000
  );
  if (daysUntilStart >= 2 && daysUntilStart <= 4) {
    return `<span class="urgency-pill urgency-pill--outlined urgency-pill--muted">${LANG.inNDays(daysUntilStart)}</span>`;
  }
  return '';
}

function renderMagazine(fromTime, toTime, grouped, festivalItems = []) {
  const counts = {};
  grouped.forEach(item => {
    counts[item.event.category] = (counts[item.event.category] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );

  if (sorted.length <= 1) {
    const allItems = [...festivalItems, ...grouped];
    return `<div class="events-list">${renderItems(allItems, fromTime, toTime)}</div>`;
  }

  const col1Cat = sorted[0][0];
  const col2Cat = sorted[1][0];

  const todaySortStr = new Date().toISOString().slice(0, 10);
  const isOngoingToday = e =>
    e.start_time.slice(0, 10) <= todaySortStr &&
    (!e.end_time || e.end_time.slice(0, 10) >= todaySortStr);
  const byStart = (a, b) => {
    const aToday = isOngoingToday(a),
      bToday = isOngoingToday(b);
    if (aToday !== bToday) return aToday ? -1 : 1;
    return a.start_time < b.start_time
      ? -1
      : a.start_time > b.start_time
        ? 1
        : 0;
  };
  const col1 = grouped
    .filter(item => item.event.category === col1Cat)
    .sort((a, b) => byStart(a.event, b.event));
  const col2 = grouped
    .filter(item => item.event.category === col2Cat)
    .sort((a, b) => byStart(a.event, b.event));
  const col3 = grouped
    .filter(
      item => item.event.category !== col1Cat && item.event.category !== col2Cat
    )
    .sort((a, b) => byStart(a.event, b.event));

  function colHtml(label, items, startIdx) {
    if (!items.length) return '';
    const cards = items
      .map((item, i) =>
        item.type === 'group'
          ? renderGroupCard(item, startIdx + i, fromTime, toTime)
          : renderEventCard(item.event, startIdx + i, fromTime, toTime)
      )
      .join('');
    return `<div class="events-magazine__col">
      <div class="events-magazine__col-header">${escHtml(label)}</div>
      ${cards}
    </div>`;
  }

  const c1 = colHtml(col1Cat, col1, 0);
  const c2 = colHtml(col2Cat, col2, col1.length);
  const c3 = col3.length
    ? colHtml(LANG.moreColumn, col3, col1.length + col2.length)
    : '';

  const cols = [c1, c2, c3].filter(Boolean);
  const festivalHtml = festivalItems
    .map((item, i) => renderFestivalCard(item, i))
    .join('');
  const magazineHtml = `<div class="events-magazine">${cols.join('')}</div>`;
  return festivalHtml
    ? `<div class="events-list" style="margin-bottom:24px">${festivalHtml}</div>${magazineHtml}`
    : magazineHtml;
}

function renderEventCard(e, idx, fromTime, toTime) {
  const color = catColor(e.category);
  const tags =
    e.tags && e.tags.length
      ? e.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')
      : '';
  const delay = Math.min(idx * 60, 400);
  const venue = [e.venue_name, e.address]
    .filter(Boolean)
    .map(escHtml)
    .join(' · ');
  const url = safeUrl(e.url);

  const days = fromTime && toTime ? effectiveDays(e, fromTime, toTime) : 1;
  const evDateStr = e.start_time.slice(0, 10);
  const { todayStr, tomorrowStr } = todayTomorrowStrs();

  let tierClass = '';
  if (days === 1 && (evDateStr === todayStr || evDateStr === tomorrowStr)) {
    tierClass = 'event-card--oneshot-now';
  } else if (days >= 5) {
    tierClass = 'event-card--extended';
  }

  const pill =
    fromTime && toTime ? renderUrgencyPill(e, color, fromTime, toTime) : '';
  const festivalPill = e.festival_name
    ? `<span class="urgency-pill urgency-pill--festival">FESTIVAL</span>`
    : '';

  return `
        <div class="event-card ${tierClass}" style="animation-delay:${delay}ms">
          <div class="event-card__stripe" style="background:${color}"></div>
          <div class="event-card__body">
            <div class="event-card__top">
              <span class="event-card__badge" style="background:${color}">${escHtml(e.category)}</span>
              <div style="text-align:right">
                <span class="event-card__date">${escHtml(fmtRange(e.start_time, e.end_time))}</span>
                ${pill ? `<br>${pill}` : ''}
                ${festivalPill ? `<br>${festivalPill}` : ''}
              </div>
            </div>
            <h3 class="event-card__title">${escHtml(e.title)}</h3>
            ${
              venue
                ? `<div class="event-card__meta">
              <span class="event-card__meta-item">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                ${venue}
              </span>
            </div>`
                : ''
            }
            ${e.description ? `<p class="event-card__desc">${escHtml(stripHtml(e.description))}</p>` : ''}
            <div class="event-card__footer">
              <div class="event-card__tags">${tags}</div>
              ${url ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="event-link">${LANG.viewEvent} <span class="arrow">→</span></a>` : ''}
            </div>
          </div>
        </div>`;
}

function renderFestivalCard(item, idx) {
  const delay = Math.min(idx * 60, 400);
  const festColor = 'var(--header)';

  const firstTime = item.events[0].start_time;
  const lastTime = item.events[item.events.length - 1].start_time;
  const dateRange = escHtml(fmtRange(firstTime, lastTime));

  const venues = [
    ...new Set(item.events.map(e => e.venue_name).filter(Boolean)),
  ];
  const venueStr = venues.slice(0, 2).map(escHtml).join(' · ');

  const count = item.events.length;

  const subRows = item.events
    .map(e => {
      const url = safeUrl(e.url);
      const timeStr = escHtml(fmtRange(e.start_time, e.end_time));
      const venuePart = e.venue_name ? ` · ${escHtml(e.venue_name)}` : '';
      const desc = e.description ? e.description.trim() : '';
      const descSnippet =
        desc.length > 120 ? escHtml(desc.slice(0, 120)) + '…' : escHtml(desc);
      return `<div class="festival-card__sub">
            <div>
              <div class="festival-card__sub-title">${escHtml(e.title)}</div>
              <div class="festival-card__sub-meta">${timeStr}${venuePart}</div>
              ${descSnippet ? `<div class="festival-card__sub-desc">${descSnippet}</div>` : ''}
            </div>
            ${url ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="festival-card__sub-link">→</a>` : ''}
          </div>`;
    })
    .join('');

  const id = `fc-${idx}`;
  return `
        <div class="event-card festival-card" id="${id}" style="animation-delay:${delay}ms">
          <div class="event-card__stripe" style="background:${festColor}"></div>
          <div class="event-card__body">
            <div class="event-card__top">
              <span class="event-card__badge" style="background:${festColor}">Festival</span>
              <span class="event-card__date">${dateRange}</span>
            </div>
            <h3 class="event-card__title">${escHtml(item.festival_name)}</h3>
            <div class="event-card__meta">
              ${
                venueStr
                  ? `<span class="event-card__meta-item">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                ${venueStr}
              </span>`
                  : ''
              }
              <span class="event-card__meta-item">${LANG.nEvents(count)}</span>
            </div>
            <button class="festival-card__toggle" data-fc-id="${escHtml(id)}">${LANG.showEvents}</button>
            <div class="festival-card__events">${subRows}</div>
          </div>
        </div>`;
}

function renderGroupCard(item, idx, fromTime, toTime) {
  const e = item.event;
  const color = catColor(e.category);
  const tags =
    e.tags && e.tags.length
      ? e.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')
      : '';
  const delay = Math.min(idx * 60, 400);
  const venue = [e.venue_name, e.address]
    .filter(Boolean)
    .map(escHtml)
    .join(' · ');

  const showtimes = item.instances
    .map(inst => {
      const label = escHtml(fmtRange(inst.start_time, inst.end_time));
      const url = safeUrl(inst.url);
      return url
        ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="showtime">${label}</a>`
        : `<span class="showtime--text">${label}</span>`;
    })
    .join('');

  let pill = '';
  if (fromTime && toTime) {
    for (const inst of item.instances) {
      const p = renderUrgencyPill(inst, color, fromTime, toTime);
      if (p) {
        pill = p;
        break;
      }
    }
  }
  const festivalPill = e.festival_name
    ? `<span class="urgency-pill urgency-pill--festival">FESTIVAL</span>`
    : '';

  return `
        <div class="event-card" style="animation-delay:${delay}ms">
          <div class="event-card__stripe" style="background:${color}"></div>
          <div class="event-card__body">
            <div class="event-card__top">
              <span class="event-card__badge" style="background:${color}">${escHtml(e.category)}</span>
              ${pill || festivalPill ? `<div style="text-align:right">${pill}${pill && festivalPill ? '<br>' : ''}${festivalPill}</div>` : ''}
            </div>
            <h3 class="event-card__title">${escHtml(e.title)}</h3>
            ${
              venue
                ? `<div class="event-card__meta">
              <span class="event-card__meta-item">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                ${venue}
              </span>
            </div>`
                : ''
            }
            <div class="event-card__showtimes">${showtimes}</div>
            <div class="event-card__footer">
              <div class="event-card__tags">${tags}</div>
            </div>
          </div>
        </div>`;
}

function renderItems(items, fromTime, toTime) {
  return items
    .map((item, i) =>
      item.type === 'festival'
        ? renderFestivalCard(item, i)
        : item.type === 'group'
          ? renderGroupCard(item, i, fromTime, toTime)
          : renderEventCard(item.event, i, fromTime, toTime)
    )
    .join('');
}

document.addEventListener('click', function (e) {
  const btn = e.target.closest('.festival-card__toggle');
  if (!btn) return;
  const card = document.getElementById(btn.dataset.fcId);
  if (!card) return;
  const open = card.classList.toggle('is-open');
  btn.textContent = open ? LANG.hideEvents : LANG.showEvents;
});

function buildShareUrl() {
  const params = new URLSearchParams();
  params.set('lat', _loadedMeta.lat);
  params.set('lng', _loadedMeta.lng);
  params.set('radius', _loadedMeta.radius);
  if (_loadedMeta.category) params.set('category', _loadedMeta.category);
  if (_loadedMeta.preset && _loadedMeta.preset !== 'custom') {
    params.set('days', _loadedMeta.preset);
  } else {
    params.set('from', _loadedMeta.fromTime);
    params.set('to', _loadedMeta.toTime);
  }
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

function buildICalUrl() {
  const { lat, lng, radius, category } = _loadedMeta;
  let url = `${API_URL}/events?lat=${lat}&lng=${lng}&radius=${radius}&window=30d&format=ical`;
  if (category) url += `&category=${encodeURIComponent(category)}`;
  return url;
}

async function copyICalUrl() {
  const url = buildICalUrl();
  const btn = document.getElementById('copyICalBtn');
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = LANG.icalCopied;
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = LANG.icalSubscribe;
      btn.classList.remove('copied');
    }, 2000);
  } catch (_) {
    prompt(LANG.icalPrompt, url);
  }
}

async function shareUrl() {
  const url = buildShareUrl();
  const btn = document.getElementById('copyLinkBtn');
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = LANG.linkCopied;
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = LANG.copyLink;
      btn.classList.remove('copied');
    }, 2000);
  } catch (_) {
    prompt(LANG.copyLinkPrompt, url);
  }
}

async function copyAsText() {
  if (!_loadedEvents.length) return;
  const { radius, category, fromTime, toTime } = _loadedMeta;
  const fmt = t =>
    new Date(t).toLocaleDateString(LANG.locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  const sep = '─'.repeat(48);
  let text = LANG.copyTextTitle(_loadedEvents.length) + '\n';
  text += `${fmt(fromTime)} – ${fmt(toTime)} · ${LANG.within} ${radius} km`;
  if (category) text += ` · ${category}`;
  text += `\n\n${sep}\n\n`;
  _loadedEvents.forEach(e => {
    text += `${e.title.toUpperCase()}\n`;
    text += `${e.category}  ·  ${fmtRange(e.start_time, e.end_time)}\n`;
    const venue = [e.venue_name, e.address].filter(Boolean).join(', ');
    if (venue) text += `${venue}\n`;
    if (e.description) text += `\n${e.description}\n`;
    if (e.url && safeUrl(e.url)) text += `\n${LANG.viewEventText} ${e.url}\n`;
    text += `\n${sep}\n\n`;
  });
  const btn = document.getElementById('copyTextBtn');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = LANG.textCopied;
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = LANG.copyAsText;
      btn.classList.remove('copied');
    }, 2000);
  } catch (_) {
    prompt(LANG.copyTextPrompt, text);
  }
}

// ── Auto-load from URL params ─────────────────────────────────────────────────
(function loadFromUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('lat') || !params.has('lng')) return;
  const lat = params.get('lat');
  const lng = params.get('lng');
  document.getElementById('queryLat').value = lat;
  document.getElementById('queryLng').value = lng;
  document.getElementById('queryAddress').value = '';
  const cd = document.getElementById('coordsDisplay');
  cd.textContent = `${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)}`;
  cd.style.display = '';
  if (params.has('radius'))
    document.getElementById('queryRadius').value = params.get('radius');
  if (params.has('category'))
    document.getElementById('queryCategory').value = params.get('category');
  if (params.has('days')) {
    document.getElementById('timeRangePreset').value = params.get('days');
  } else if (params.has('from') && params.has('to')) {
    document.getElementById('timeRangePreset').value = 'custom';
    handleTimeRangePresetChange();
    document.getElementById('queryFromTime').value = params
      .get('from')
      .slice(0, 16);
    document.getElementById('queryToTime').value = params
      .get('to')
      .slice(0, 16);
  }
  listEvents();
})();
