// Global state
let extractedEvents = null;
let currentUrl = null;
let isFromCache = false; // Track whether events were loaded from cache
let isFromImage = false; // Track whether events came from image extraction
let imageSource = null; // Store image source URL for publishing
let imagePageUrl = null; // Store page URL when crawling an image (used as event URL)

// ── Ed25519 helpers using Web Crypto API (Chrome 111+) ──────────────────────

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateKeypair() {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const privBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  return {
    pubkey: bytesToHex(pubBytes),
    privkeyB64: btoa(String.fromCharCode(...privBytes)),
  };
}

async function loadOrGenerateKeypair() {
  const stored = await chrome.storage.sync.get(['pubkey', 'privkeyB64']);
  if (stored.pubkey && stored.privkeyB64) return { ...stored, isNew: false };
  const kp = await generateKeypair();
  await chrome.storage.sync.set({ pubkey: kp.pubkey, privkeyB64: kp.privkeyB64 });
  return { ...kp, isNew: true };
}

async function signEvent(preparedEvent, pubkey, privkeyB64) {
  const eventData = {
    pubkey,
    title: preparedEvent.title,
    description: preparedEvent.description || '',
    url: preparedEvent.url || '',
    venue_name: preparedEvent.venue_name || '',
    address: preparedEvent.address || '',
    lat: preparedEvent.lat,
    lng: preparedEvent.lng,
    start_time: preparedEvent.start_time,
    end_time: preparedEvent.end_time,
    category: preparedEvent.category,
    tags: preparedEvent.tags || [],
    created_at: preparedEvent.created_at,
  };
  const canonical = JSON.stringify(eventData);
  const msgBytes = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBytes);
  const privBytes = Uint8Array.from(atob(privkeyB64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', privBytes.buffer, 'Ed25519', false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('Ed25519', cryptoKey, new Uint8Array(hashBuffer));
  return { ...eventData, signature: bytesToHex(new Uint8Array(sigBuffer)) };
}

// Get the current tab URL and display it
async function getCurrentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.url;
}

// Show or hide the settings section based on whether fields are filled
function updateSettingsVisibility(forceShow = false) {
  const apiKey = document.getElementById('apiKey').value;
  const workerUrl = document.getElementById('workerUrl').value;
  const apiUrl = document.getElementById('apiUrl').value;
  const section = document.getElementById('settingsSection');
  const toggleRow = document.getElementById('settingsToggleRow');

  if (forceShow || !apiKey || !workerUrl || !apiUrl) {
    section.style.display = 'block';
    toggleRow.style.display = 'none';
  } else {
    section.style.display = 'none';
    toggleRow.style.display = 'block';
  }
}

// Load saved settings
async function loadSettings() {
  const result = await chrome.storage.sync.get(['apiKey', 'workerUrl', 'apiUrl', 'pubkey', 'privkeyB64']);

  if (result.apiKey) document.getElementById('apiKey').value = result.apiKey;
  if (result.workerUrl) document.getElementById('workerUrl').value = result.workerUrl;
  if (result.apiUrl) document.getElementById('apiUrl').value = result.apiUrl;

  // Initialise keypair (generates one if not yet stored)
  const kp = await loadOrGenerateKeypair();
  const pubkeySection = document.getElementById('pubkeySection');
  const pubkeyDisplay = document.getElementById('pubkeyDisplay');
  if (pubkeySection && pubkeyDisplay) {
    pubkeyDisplay.textContent = kp.pubkey;
    pubkeySection.style.display = 'block';
  }
  if (kp.isNew) {
    const notice = document.getElementById('newKeypairNotice');
    if (notice) notice.style.display = 'block';
  }

  updateSettingsVisibility();
}

// Save settings
async function saveSettings() {
  const apiKey = document.getElementById('apiKey').value;
  const workerUrl = document.getElementById('workerUrl').value;
  const apiUrl = document.getElementById('apiUrl').value;
  await chrome.storage.sync.set({ apiKey, workerUrl, apiUrl });
}

// Save extracted events to cache
async function cacheExtractedEvents(url, events) {
  const cacheKey = `cached_events_${url}`;
  await chrome.storage.local.set({
    [cacheKey]: {
      events,
      timestamp: Date.now(),
    },
  });
  console.log(`[Popup] Cached ${events.length} events for URL: ${url}`);
}

// Load cached events for a URL
async function loadCachedEvents(url) {
  const cacheKey = `cached_events_${url}`;
  const result = await chrome.storage.local.get(cacheKey);

  if (result[cacheKey]) {
    console.log(
      `[Popup] Loaded ${result[cacheKey].events.length} cached events for URL: ${url}`
    );
    return result[cacheKey].events;
  }

  return null;
}

// Show status message
function showStatus(message, type, stats = null) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';

  if (stats) {
    const statsHtml = `
      <div class="stats">
        URLs processed: ${stats.urls_processed} |
        Events extracted: ${stats.events_extracted} |
        Events published: ${stats.events_published}
      </div>
    `;
    statusEl.innerHTML = message + statsHtml;
  }
}

// Format a start/end date pair as an interval string.
// Examples: "14.02.2026 8pm–10pm" or "14.02–07.06.2026"
// Handles ISO strings (e.g., "2026-03-21T20:30:00") and Unix timestamps (e.g., 1742584200).
function formatDateRange(startValue, endValue) {
  const hasTime = v => typeof v === 'string' ? v.includes('T') : typeof v === 'number';

  function parseVal(v) {
    if (!v) return null;
    // Date-only strings (e.g. "2026-06-10") are parsed by JS as UTC midnight, which shifts
    // the displayed date in non-UTC timezones. Rewrite as local noon to keep the right date.
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = v + 'T12:00:00';
    const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  const start = parseVal(startValue);
  if (!start) return 'Date not specified';
  const end = parseVal(endValue);

  const startHasTime = hasTime(startValue);
  const endHasTime = hasTime(endValue);

  // DD.MM.YYYY
  const dp = d =>
    String(d.getDate()).padStart(2, '0') + '.' +
    String(d.getMonth() + 1).padStart(2, '0') + '.' +
    d.getFullYear();

  // DD.MM (no year)
  const ds = d =>
    String(d.getDate()).padStart(2, '0') + '.' +
    String(d.getMonth() + 1).padStart(2, '0');

  // e.g. 8pm or 10:30am
  const tp = d => {
    const h = d.getHours(), m = d.getMinutes();
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    return m ? `${h12}:${String(m).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
  };

  if (!end) return startHasTime ? `${dp(start)} ${tp(start)}` : dp(start);

  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();

  // Treat overnight events (end is next calendar day but before noon) as same day for display.
  const nextDayMorning = !sameDay &&
    end.getTime() - start.getTime() < 24 * 60 * 60 * 1000 &&
    end.getHours() < 12;

  if (sameDay || nextDayMorning) {
    if (!startHasTime) return dp(start);
    return endHasTime ? `${dp(start)} ${tp(start)}–${tp(end)}` : `${dp(start)} ${tp(start)}`;
  }
  if (start.getFullYear() === end.getFullYear()) return `${ds(start)}–${dp(end)}`;
  return `${dp(start)}–${dp(end)}`;
}

// Display events in the preview section
function displayEventPreview(events) {
  const previewContainer = document.getElementById('eventsPreview');
  previewContainer.innerHTML = '';

  if (!events || events.length === 0) {
    previewContainer.innerHTML =
      '<p style="color: #999;">No events extracted. The page may only contain past events.</p>';
    return;
  }

  events.forEach((event, index) => {
    const eventDiv = document.createElement('div');
    eventDiv.className = 'event-preview';

    const title = event.title || 'Untitled Event';
    const dateRange = formatDateRange(event.start_time, event.end_time);
    const venue = event.venue_name || 'Venue not specified';
    const address = event.address || 'Address not specified';
    const category = event.category || 'other';

    const description = event.description || '';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'event-select';
    cb.checked = true;
    cb.setAttribute('aria-label', `Select "${title}"`);
    cb.addEventListener('change', updatePublishButton);

    eventDiv.innerHTML = `
      <h3>${title}</h3>
      <p class="event-date">📅 ${dateRange}</p>
      <p>📍 ${venue}</p>
      <p style="font-size: 11px;">${address}</p>
      ${description ? `<p style="font-size: 11px; color: #555; margin-top: 4px;">${description}</p>` : ''}
      <p style="font-size: 11px; color: #999;">Category: ${category}</p>
    `;
    eventDiv.appendChild(cb);
    previewContainer.appendChild(eventDiv);
  });

  updatePublishButton();
}

// Show/hide preview section
function togglePreviewSection(show) {
  const previewSection = document.getElementById('previewSection');
  if (show) {
    previewSection.classList.add('visible');
  } else {
    previewSection.classList.remove('visible');
  }
}

// Return only the events whose checkbox is checked
function getSelectedEvents() {
  if (!extractedEvents) return [];
  const checkboxes = document.querySelectorAll('#eventsPreview .event-select');
  return extractedEvents.filter((_, i) => checkboxes[i] && checkboxes[i].checked);
}

// Update publish button label and enabled state based on selection
function updatePublishButton() {
  const total = extractedEvents ? extractedEvents.length : 0;
  const selected = getSelectedEvents().length;
  const btn = document.getElementById('publishButton');
  if (selected === 0) {
    btn.disabled = true;
    btn.textContent = 'Publish Events';
  } else if (selected < total) {
    btn.disabled = false;
    btn.textContent = `Publish ${selected} Event${selected === 1 ? '' : 's'}`;
  } else {
    btn.disabled = false;
    btn.textContent = 'Publish Events';
  }
}

// Extract rendered HTML from the current tab
// Returns the fully-rendered HTML and page title; cleaning is handled server-side
async function extractRenderedContent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const extractFunc = () => {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, svg')
      .forEach(el => el.remove());
    return { html: clone.outerHTML, title: document.title };
  };

  // Main frame — always fast and reliable
  const mainResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    func: extractFunc,
  });
  const mainHtml = mainResults?.[0]?.result?.html || '';
  const title = mainResults?.[0]?.result?.title || '';

  // Iframes — wrapped in a 5 s timeout so a stuck widget can't hang the whole extraction
  let iframeHtmls = [];
  try {
    const iframeResults = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: extractFunc }),
      new Promise(resolve => setTimeout(() => resolve([]), 5000)),
    ]);
    iframeHtmls = (iframeResults || [])
      .slice(1) // index 0 is the main frame again; skip it
      .filter(r => r?.result?.html)
      .map(r => r.result.html);
  } catch (e) {
    // iframe extraction failed or timed out — proceed with main frame only
  }

  const combinedHtml = [mainHtml, ...iframeHtmls].filter(Boolean).join('\n');
  const html = combinedHtml.length > 400000 ? combinedHtml.substring(0, 400000) : combinedHtml;
  return { html, title };
}

// Step 1a: Preview events extracted from an image (re-crawl)
async function previewImageEvents(apiKey, workerUrl) {
  const button = document.getElementById('crawlButton');
  button.disabled = true;
  button.textContent = 'Extracting from image...';
  showStatus('Extracting events from image...', 'info');
  togglePreviewSection(false);

  try {
    const response = await fetch(`${workerUrl}/crawl`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: imagePageUrl || currentUrl,
        mode: 'image',
        preview: true,
        imageData: window.pendingImageData.imageData,
        imageMimeType: window.pendingImageData.imageMimeType,
      }),
    });

    const data = await response.json();

    console.log('[Popup] --- CRAWLER-WORKER RESPONSE ---');
    console.log(JSON.stringify(data, null, 2));
    console.log('[Popup] --- END CRAWLER-WORKER RESPONSE ---');

    // Also log to page console
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: responseData => {
        console.log('[Tokoro] --- CRAWLER-WORKER RESPONSE ---');
        console.log(JSON.stringify(responseData, null, 2));
        console.log('[Tokoro] --- END CRAWLER-WORKER RESPONSE ---');
      },
      args: [data],
    });

    if (response.ok && data.success) {
      extractedEvents = data.events;

      // Update stored pending extraction with fresh results
      await chrome.storage.local.set({
        pending_image_extraction: {
          events: data.events,
          imageSource: imageSource,
          imageData: window.pendingImageData.imageData,
          imageMimeType: window.pendingImageData.imageMimeType,
          timestamp: Date.now(),
        },
      });

      if (extractedEvents && extractedEvents.length > 0) {
        console.log('[Popup] --- EXTRACTED EVENTS ---');
        console.log(JSON.stringify(extractedEvents, null, 2));
        console.log('[Popup] --- END EXTRACTED EVENTS ---');

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: events => {
            console.log('[Tokoro] --- EXTRACTED EVENTS ---');
            console.log(JSON.stringify(events, null, 2));
            console.log('[Tokoro] --- END EXTRACTED EVENTS ---');
          },
          args: [extractedEvents],
        });

        showStatus(`Found ${extractedEvents.length} event(s). Review below:`, 'success');
        displayEventPreview(extractedEvents);
        togglePreviewSection(true);
      } else {
        showStatus('No events found in image. The image may only show past events.', 'error');
        togglePreviewSection(false);
      }

      if (data.dropped_events && data.dropped_events.length > 0) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: dropped => {
            console.warn('[Tokoro] Events were extracted but dropped during normalization:');
            dropped.forEach((d, i) => {
              console.warn(`  [${i + 1}] "${d.title}": ${d.reason}` +
                (d.address ? ` | address: "${d.address}"` : '') +
                (d.venue_name ? ` | venue: "${d.venue_name}"` : ''));
            });
          },
          args: [data.dropped_events],
        });
      }
    } else {
      showStatus(`Error: ${data.message || data.error || 'Unknown error'}`, 'error');
      togglePreviewSection(false);
    }
  } catch (error) {
    showStatus(`Network error: ${error.message}`, 'error');
    togglePreviewSection(false);
  } finally {
    button.disabled = false;
    button.textContent = 'Extract From Image Again';
  }
}

// Step 1b: Preview events extracted from the current page
async function previewPageEvents(apiKey, workerUrl) {
  const button = document.getElementById('crawlButton');
  button.disabled = true;
  button.textContent = isFromCache ? 'Re-crawling...' : 'Extracting...';
  showStatus('Extracting events from page...', 'info');
  togglePreviewSection(false);

  try {
    // Extract rendered content from the current tab
    showStatus('Extracting page content...', 'info');
    const content = await extractRenderedContent();
    console.log(`[Popup] Extracted content - HTML: ${content.html.length} chars`);

    // Make API call to crawler worker with preview=true and rendered content
    showStatus('Analyzing page content...', 'info');
    const response = await fetch(`${workerUrl}/crawl`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: currentUrl,
        mode: 'direct',
        preview: true,
        html: content.html,   // Send rendered HTML; cleaning is handled server-side
        title: content.title, // Send page title
      }),
    });

    const data = await response.json();

    console.log('[Popup] --- CRAWLER-WORKER RESPONSE ---');
    console.log(JSON.stringify(data, null, 2));
    console.log('[Popup] --- END CRAWLER-WORKER RESPONSE ---');

    // Also log to page console
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (responseData, cleanedText) => {
        console.log('[Tokoro] --- CRAWLER-WORKER RESPONSE ---');
        console.log(JSON.stringify(responseData, null, 2));
        console.log('[Tokoro] --- END CRAWLER-WORKER RESPONSE ---');
        if (cleanedText) {
          console.log('[Tokoro] --- CLEANED TEXT (sent to LLM) ---');
          console.log(cleanedText);
          console.log('[Tokoro] --- END CLEANED TEXT ---');
        }
      },
      args: [data, data.cleaned_text || null],
    });

    if (response.ok && data.success) {
      extractedEvents = data.events;
      isFromCache = false;

      if (extractedEvents && extractedEvents.length > 0) {
        console.log('[Popup] --- EXTRACTED EVENTS ---');
        console.log(JSON.stringify(extractedEvents, null, 2));
        console.log('[Popup] --- END EXTRACTED EVENTS ---');

        // Cache the extracted events
        await cacheExtractedEvents(currentUrl, extractedEvents);

        // Also log to page console
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: events => {
            console.log('[Tokoro] --- EXTRACTED EVENTS ---');
            console.log(JSON.stringify(events, null, 2));
            console.log('[Tokoro] --- END EXTRACTED EVENTS ---');
          },
          args: [extractedEvents],
        });

        showStatus(
          `Found ${extractedEvents.length} event(s). Review below:`,
          'success'
        );
        displayEventPreview(extractedEvents);
        togglePreviewSection(true);
      } else {
        const dropped = data.dropped_events;
        if (dropped && dropped.length > 0) {
          showStatus(`${dropped.length} event(s) found but dropped during normalization. Check console for details.`, 'error');
        } else {
          showStatus('No events found on this page. The page may only contain past events.', 'error');
        }
        togglePreviewSection(false);
      }

      // Always log dropped events to the page console if any events were extracted but not normalized
      if (data.dropped_events && data.dropped_events.length > 0) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: dropped => {
            console.warn('[Tokoro] Events were extracted but dropped during normalization:');
            dropped.forEach((d, i) => {
              console.warn(`  [${i + 1}] "${d.title}": ${d.reason}` +
                (d.address ? ` | address: "${d.address}"` : '') +
                (d.venue_name ? ` | venue: "${d.venue_name}"` : ''));
            });
          },
          args: [data.dropped_events],
        });
      }
    } else {
      showStatus(
        `Error: ${data.message || data.error || 'Unknown error'}`,
        'error'
      );
      togglePreviewSection(false);
    }
  } catch (error) {
    showStatus(`Network error: ${error.message}`, 'error');
    togglePreviewSection(false);
  } finally {
    // Re-enable button and update text based on cache state
    button.disabled = false;
    button.textContent = isFromCache ? 'Re-crawl This Page' : 'Crawl This Page';
  }
}

// Step 1: Preview the extracted events (dispatches to image or page crawl)
async function previewEvents() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const workerUrl = document.getElementById('workerUrl').value.trim();
  currentUrl = await getCurrentTabUrl();

  // Validate inputs
  if (!apiKey) {
    updateSettingsVisibility(true);
    showStatus('Please enter your API key', 'error');
    return;
  }

  if (!workerUrl) {
    updateSettingsVisibility(true);
    showStatus('Please enter the crawler worker URL', 'error');
    return;
  }

  // Save settings
  await saveSettings();

  if (isFromImage) {
    await previewImageEvents(apiKey, workerUrl);
  } else {
    await previewPageEvents(apiKey, workerUrl);
  }
}

// Step 2: Publish the events to the API
async function publishEvents() {
  const selectedEvents = getSelectedEvents();
  if (!selectedEvents || selectedEvents.length === 0) {
    showStatus('No events selected to publish', 'error');
    return;
  }

  const apiUrl = document.getElementById('apiUrl').value.trim();
  if (!apiUrl) {
    updateSettingsVisibility(true);
    showStatus('Please enter the API Worker URL', 'error');
    return;
  }

  const publishButton = document.getElementById('publishButton');
  const cancelButton = document.getElementById('cancelButton');
  publishButton.disabled = true;
  cancelButton.disabled = true;
  publishButton.textContent = 'Publishing...';
  showStatus('Publishing events...', 'info');

  try {
    const kp = await loadOrGenerateKeypair();
    let published = 0;
    let failed = 0;

    for (const event of selectedEvents) {
      try {
        const signed = await signEvent(event, kp.pubkey, kp.privkeyB64);
        // Append unsigned metadata fields (not part of signature)
        if (event.festival_name) signed.festival_name = event.festival_name;
        if (event.festival_url)  signed.festival_url  = event.festival_url;
        const response = await fetch(`${apiUrl}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signed),
        });
        if (response.ok || response.status === 409) {
          published++;
        } else {
          const err = await response.json().catch(() => ({}));
          console.error(`Failed to publish "${event.title}":`, err);
          failed++;
        }
      } catch (err) {
        console.error(`Network error publishing "${event.title}":`, err);
        failed++;
      }
    }

    const stats = { urls_processed: 1, events_extracted: selectedEvents.length, events_published: published };
    if (failed === 0) {
      showStatus('Events published successfully!', 'success', stats);
    } else {
      showStatus(`Published ${published}, failed ${failed}. Check console for details.`, 'error', stats);
    }

    if (published > 0) {
      togglePreviewSection(false);
      extractedEvents = null;
      isFromImage = false;
      imageSource = null;
      imagePageUrl = null;
      window.pendingImageData = null;
      await chrome.storage.local.remove('pending_image_extraction');
    }
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    publishButton.disabled = false;
    cancelButton.disabled = false;
    updatePublishButton();
  }
}

// Cancel the preview
async function cancelPreview() {
  extractedEvents = null;
  togglePreviewSection(false);
  showStatus('Preview cancelled', 'info');

  const button = document.getElementById('crawlButton');
  button.disabled = false;

  // Clean up image extraction state if applicable
  if (isFromImage) {
    isFromImage = false;
    imageSource = null;
    imagePageUrl = null;
    window.pendingImageData = null;
    await chrome.storage.local.remove('pending_image_extraction');
    button.textContent = 'Crawl This Page';
  }

  await chrome.storage.local.remove('pending_page_crawl');
}

// Apply a completed image extraction result to the popup UI
function applyImageExtractionResult(pending) {
  const button = document.getElementById('crawlButton');
  button.disabled = false;
  button.textContent = 'Extract From Image Again';

  if (pending.error) {
    showStatus(`Error: ${pending.error}`, 'error');
    togglePreviewSection(false);
    return;
  }

  if (!pending.events || !Array.isArray(pending.events) || !pending.imageData || !pending.imageMimeType) {
    showStatus('Invalid response from image extraction.', 'error');
    togglePreviewSection(false);
    return;
  }

  extractedEvents = pending.events;
  isFromImage = true;
  isFromCache = false;
  imageSource = pending.imageSource;
  imagePageUrl = pending.pageUrl || null;
  window.pendingImageData = {
    imageData: pending.imageData,
    imageMimeType: pending.imageMimeType
  };

  if (pending.events.length > 0) {
    showStatus(`Found ${pending.events.length} event(s) from image. Review and publish:`, 'success');
    displayEventPreview(pending.events);
    togglePreviewSection(true);
  } else {
    showStatus('No events found in image. The image may only show past events. Try a different image or check if the image contains event information.', 'error');
    togglePreviewSection(false);
  }
}

// Apply a completed page crawl preview result to the popup UI
function applyPageCrawlResult(pageCrawl) {
  if (pageCrawl.error) {
    showStatus(`Crawl failed: ${pageCrawl.error}`, 'error');
    togglePreviewSection(false);
    return;
  }

  extractedEvents = pageCrawl.events || [];
  isFromImage = false;
  isFromCache = false;

  if (extractedEvents.length > 0) {
    showStatus(`Found ${extractedEvents.length} event(s). Review and publish:`, 'success');
    displayEventPreview(extractedEvents);
    togglePreviewSection(true);
  } else {
    showStatus('No events found on this page. The page may only contain past events.', 'error');
    togglePreviewSection(false);
  }
}

// Initialize popup
async function init() {
  // Load settings
  await loadSettings();

  // Display current URL
  const url = await getCurrentTabUrl();
  currentUrl = url;
  document.getElementById('currentUrl').textContent = url;

  // Check for pending image extraction first (takes priority over cached page events)
  const { pending_image_extraction: pending, pending_page_crawl: pageCrawl } =
    await chrome.storage.local.get(['pending_image_extraction', 'pending_page_crawl']);

  if (pending) {
    console.log('[Popup] Found pending image extraction:', pending);

    // Check if the pending extraction is stale (older than 2 minutes)
    const TWO_MINUTES = 2 * 60 * 1000;
    const isStale = pending.timestamp && (Date.now() - pending.timestamp) > TWO_MINUTES;

    if (isStale) {
      console.log('[Popup] Pending image extraction is stale (>2 minutes old), clearing...');
      await chrome.storage.local.remove('pending_image_extraction');

      // Check for cached page events instead
      const cachedEvents = await loadCachedEvents(url);
      if (cachedEvents && cachedEvents.length > 0) {
        extractedEvents = cachedEvents;
        isFromCache = true;
        isFromImage = false;
        showStatus(`Found ${cachedEvents.length} previously extracted event(s). Review and publish, or re-crawl:`, 'info');
        displayEventPreview(cachedEvents);
        togglePreviewSection(true);
      }
    } else if (pending.loading) {
      // Still processing — show loading state and wait for storage update
      isFromImage = true;
      imageSource = pending.imageSource;
      imagePageUrl = pending.pageUrl || null;
      const button = document.getElementById('crawlButton');
      button.textContent = 'Extract From Image Again';
      button.disabled = true;
      showStatus('Extracting event data from image...', 'info');
    } else if (pending.events && Array.isArray(pending.events) &&
        pending.imageData && pending.imageMimeType) {
      applyImageExtractionResult(pending);
    } else {
      // Invalid or incomplete pending data, clear it
      console.warn('[Popup] Invalid pending image extraction data, clearing...');
      await chrome.storage.local.remove('pending_image_extraction');

      // Check for cached page events instead
      const cachedEvents = await loadCachedEvents(url);
      if (cachedEvents && cachedEvents.length > 0) {
        extractedEvents = cachedEvents;
        isFromCache = true;
        isFromImage = false;
        showStatus(`Found ${cachedEvents.length} previously extracted event(s). Review and publish, or re-crawl:`, 'info');
        displayEventPreview(cachedEvents);
        togglePreviewSection(true);
      }
    }
  } else if (pageCrawl) {
    console.log('[Popup] Found pending page crawl:', pageCrawl);

    if (pageCrawl.loading) {
      showStatus('Crawling page...', 'info');
      document.getElementById('crawlButton').disabled = true;
    } else {
      await chrome.storage.local.remove('pending_page_crawl');
      applyPageCrawlResult(pageCrawl);
    }
  } else {
    // Check for cached events from page crawl
    const cachedEvents = await loadCachedEvents(url);
    if (cachedEvents && cachedEvents.length > 0) {
      extractedEvents = cachedEvents;
      isFromCache = true;
      isFromImage = false;
      showStatus(`Found ${cachedEvents.length} previously extracted event(s). Review and publish, or re-crawl:`, 'info');
      displayEventPreview(cachedEvents);
      togglePreviewSection(true);
    }
  }

  // Listen for storage updates from the background (e.g. image processing completing)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.pending_image_extraction) {
      const newVal = changes.pending_image_extraction.newValue;
      if (!newVal || newVal.loading) return;
      applyImageExtractionResult(newVal);
    }

    if (changes.pending_page_crawl) {
      const newVal = changes.pending_page_crawl.newValue;
      if (!newVal || newVal.loading) return;
      chrome.storage.local.remove('pending_page_crawl');
      document.getElementById('crawlButton').disabled = false;
      applyPageCrawlResult(newVal);
    }
  });

  // Set up event listeners
  document
    .getElementById('crawlButton')
    .addEventListener('click', previewEvents);
  document
    .getElementById('publishButton')
    .addEventListener('click', publishEvents);
  document
    .getElementById('cancelButton')
    .addEventListener('click', cancelPreview);
  document
    .getElementById('settingsToggle')
    .addEventListener('click', (e) => {
      e.preventDefault();
      updateSettingsVisibility(true);
    });

  // Save settings on input change
  document.getElementById('apiKey').addEventListener('change', saveSettings);
  document.getElementById('workerUrl').addEventListener('change', saveSettings);
  document.getElementById('apiUrl').addEventListener('change', saveSettings);
}

// Run initialization when popup opens
init();
