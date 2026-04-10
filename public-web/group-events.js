/**
 * Groups events with the same title+venue_name into a single entry.
 * Returns an array of items, each either:
 *   { type: 'single', event }
 *   { type: 'group',  event, instances: [{ id, start_time, end_time, url }] }
 *
 * Groups only form when ≥2 events share the same key.
 * Instances within a group are sorted ascending by start_time.
 * Group metadata (event) comes from the earliest instance.
 */
function groupEvents(events) {
  const key = e =>
    (e.title || '').trim().toLowerCase() + '|' + (e.venue_name || '').trim().toLowerCase();

  // Collect into buckets
  const buckets = new Map();
  for (const e of events) {
    const k = key(e);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }

  // Preserve original order of first occurrence of each key
  const seen = new Map();
  const ordered = [];
  for (const e of events) {
    const k = key(e);
    if (!seen.has(k)) {
      seen.set(k, true);
      ordered.push(k);
    }
  }

  return ordered.map(k => {
    const group = buckets.get(k);
    if (group.length === 1) {
      return { type: 'single', event: group[0] };
    }
    const sorted = group.slice().sort((a, b) =>
      a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0
    );
    return {
      type: 'group',
      event: sorted[0],
      instances: sorted.map(e => ({ id: e.id, start_time: e.start_time, end_time: e.end_time, url: e.url })),
    };
  });
}

/**
 * Separates events into festival groups and remaining events.
 * A festival group forms when 3+ events share the same festival_url.
 *
 * Returns:
 *   festivalItems: Array of { type: 'festival', festival_url, festival_name, events[] }
 *                  sorted by earliest event start_time
 *   remainingEvents: events not belonging to any festival group
 */
function groupFestivals(events) {
  const buckets = new Map();
  for (const e of events) {
    if (!e.festival_url) continue;
    if (!buckets.has(e.festival_url)) buckets.set(e.festival_url, []);
    buckets.get(e.festival_url).push(e);
  }

  const festivalUrls = new Set();
  const festivalItems = [];

  for (const [url, evts] of buckets) {
    if (evts.length < 3) continue;
    festivalUrls.add(url);
    const sorted = evts.slice().sort((a, b) =>
      a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0
    );
    festivalItems.push({
      type: 'festival',
      festival_url: url,
      festival_name: sorted[0].festival_name || url,
      events: sorted,
    });
  }

  festivalItems.sort((a, b) =>
    a.events[0].start_time < b.events[0].start_time ? -1 :
    a.events[0].start_time > b.events[0].start_time ? 1 : 0
  );

  const remainingEvents = events.filter(e => !festivalUrls.has(e.festival_url));
  return { festivalItems, remainingEvents };
}

// Available as a global in the browser; exportable via require() in Node tests
if (typeof module !== 'undefined') module.exports = { groupEvents, groupFestivals };
if (typeof window !== 'undefined') {
  window.groupEvents = groupEvents;
  window.groupFestivals = groupFestivals;
}
