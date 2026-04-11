// Background service worker for Tokoro Event Crawler extension

// Listen for extension installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('Tokoro Event Crawler extension installed');
});

// Clear cached events when a tab navigates or reloads, so the popup shows a fresh state
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    const cacheKey = `cached_events_${tab.url}`;
    await chrome.storage.local.remove(cacheKey);
    console.log('[Tokoro] Cleared event cache on navigation:', tab.url);
  }
});

// No need to track position here - content script handles it

// Add context menu items for right-click crawling
chrome.runtime.onInstalled.addListener(() => {
  // Context menu for pages
  chrome.contextMenus.create({
    id: 'crawlThisPage',
    title: 'Crawl this page with Tokoro',
    contexts: ['page']
  });

  // Context menu for images (traditional - works when Chrome detects an image)
  chrome.contextMenus.create({
    id: 'crawlThisImage',
    title: 'Extract event from this image',
    contexts: ['image']
  });

  // Context menu for any element (works around div overlays like on Instagram)
  chrome.contextMenus.create({
    id: 'extractFromElement',
    title: 'Extract event from element',
    contexts: ['page', 'image', 'link']
  });
});

// Helper function to find image at the last right-click position using content script
async function findImageAtLastPosition(tab) {
  try {
    // Execute script to get the last right-click position and find image there
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Get the last stored position from the content script's global variable
        // If content script isn't loaded, we won't have the position
        if (!window.tokoroExtension || !window.tokoroExtension.lastContextMenuPosition) {
          console.log('[Tokoro] Content script position not available');
          return null;
        }

        const x = window.tokoroExtension.lastContextMenuPosition.x;
        const y = window.tokoroExtension.lastContextMenuPosition.y;

        console.log('[Tokoro] Finding image at position:', x, y);

        // Function to extract image URL from an element
        function getImageUrl(element) {
          // Check if it's an img tag
          if (element.tagName === 'IMG' && element.src) {
            return element.src;
          }

          // Check for background image in CSS
          const bgImage = window.getComputedStyle(element).backgroundImage;
          if (bgImage && bgImage !== 'none') {
            // Extract URL from url("...") or url('...')
            const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
            if (match && match[1]) {
              return match[1];
            }
          }

          return null;
        }

        // Start from the element at the click position
        let element = document.elementFromPoint(x, y);

        if (!element) {
          console.log('[Tokoro] No element found at position');
          return null;
        }

        console.log('[Tokoro] Element at click position:', element.tagName, element.className);

        // Try to find an image in this element or its children
        // First check the clicked element itself
        let imageUrl = getImageUrl(element);
        if (imageUrl) {
          console.log('[Tokoro] Found image URL on clicked element:', imageUrl);
          return imageUrl;
        }

        // Check for img elements within the clicked element
        const imgElements = element.querySelectorAll('img');
        if (imgElements.length > 0) {
          imageUrl = imgElements[0].src;
          if (imageUrl) {
            console.log('[Tokoro] Found img element within clicked element:', imageUrl);
            return imageUrl;
          }
        }

        // Walk up the DOM tree looking for an image
        let parent = element.parentElement;
        let depth = 0;
        const maxDepth = 5; // Don't go too far up

        while (parent && depth < maxDepth) {
          imageUrl = getImageUrl(parent);
          if (imageUrl) {
            console.log('[Tokoro] Found image URL on parent element:', imageUrl);
            return imageUrl;
          }

          // Check for img elements within the parent
          const parentImgs = parent.querySelectorAll('img');
          if (parentImgs.length > 0) {
            imageUrl = parentImgs[0].src;
            if (imageUrl) {
              console.log('[Tokoro] Found img element within parent:', imageUrl);
              return imageUrl;
            }
          }

          parent = parent.parentElement;
          depth++;
        }

        // Last resort: look for any img at or near the click position
        // by checking siblings and nearby elements
        element = document.elementFromPoint(x, y);
        if (element && element.parentElement) {
          const siblings = element.parentElement.children;
          for (let sibling of siblings) {
            if (sibling.tagName === 'IMG' && sibling.src) {
              console.log('[Tokoro] Found img element in siblings:', sibling.src);
              return sibling.src;
            }

            const siblingImg = sibling.querySelector('img');
            if (siblingImg && siblingImg.src) {
              console.log('[Tokoro] Found img element in sibling descendants:', siblingImg.src);
              return siblingImg.src;
            }
          }
        }

        console.log('[Tokoro] No image found at position or nearby');
        return null;
      },
      world: 'MAIN'
    });

    const imageUrl = results?.[0]?.result;
    console.log('[Tokoro] Image search result:', imageUrl);
    return imageUrl;
  } catch (error) {
    console.error('[Tokoro] Error finding image:', error);
    return null;
  }
}

// Helper function to convert image URL to base64 with scaling/compression
// Uses OffscreenCanvas which is available in Service Workers (background scripts)
async function imageUrlToBase64(imageUrl, maxDimension = 1024, quality = 0.85) {
  console.log('[Tokoro] imageUrlToBase64: Fetching image from:', imageUrl);
  try {
    const response = await fetch(imageUrl);
    console.log('[Tokoro] imageUrlToBase64: Fetch response status:', response.status);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const blob = await response.blob();
    console.log('[Tokoro] imageUrlToBase64: Original blob size:', blob.size, 'bytes, type:', blob.type);

    // Use createImageBitmap which is available in Service Workers
    const imageBitmap = await createImageBitmap(blob);

    const originalWidth = imageBitmap.width;
    const originalHeight = imageBitmap.height;
    console.log('[Tokoro] imageUrlToBase64: Original dimensions:', originalWidth, 'x', originalHeight);

    // Calculate scaled dimensions while maintaining aspect ratio
    let targetWidth = originalWidth;
    let targetHeight = originalHeight;

    if (originalWidth > maxDimension || originalHeight > maxDimension) {
      if (originalWidth > originalHeight) {
        targetWidth = maxDimension;
        targetHeight = Math.round((originalHeight * maxDimension) / originalWidth);
      } else {
        targetHeight = maxDimension;
        targetWidth = Math.round((originalWidth * maxDimension) / originalHeight);
      }
      console.log('[Tokoro] imageUrlToBase64: Scaling to:', targetWidth, 'x', targetHeight);
    } else {
      console.log('[Tokoro] imageUrlToBase64: Image is already small enough, no scaling needed');
    }

    // Use OffscreenCanvas which is available in Service Workers
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, targetWidth, targetHeight);

    // Convert to blob then to base64
    const compressedBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: quality
    });

    // Convert blob to base64
    const arrayBuffer = await compressedBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const mimeType = 'image/jpeg';

    // Calculate size reduction
    const originalBase64Length = Math.ceil((blob.size * 4) / 3); // Approximate base64 size
    const newBase64Length = base64.length;
    const reductionPercent = Math.round((1 - newBase64Length / originalBase64Length) * 100);

    console.log('[Tokoro] imageUrlToBase64: Compressed base64 length:', newBase64Length, 'bytes');
    console.log('[Tokoro] imageUrlToBase64: Size reduction:', reductionPercent + '%');

    // Clean up
    imageBitmap.close();

    return { base64, mimeType };
  } catch (error) {
    console.error('[Tokoro] imageUrlToBase64: Error:', error);
    throw new Error(`Failed to fetch image: ${error.message}`);
  }
}

// Handle image crawl: open popup immediately with loading state, process in background
async function handleImageCrawl(imageUrl, tab, apiKey, workerUrl) {
  // 1. Write loading state and open popup immediately
  await chrome.storage.local.set({
    pending_image_extraction: {
      loading: true,
      imageSource: imageUrl,
      pageUrl: tab.url,
      timestamp: Date.now()
    }
  });
  chrome.action.openPopup();

  // 2. Process image and call API in the background
  try {
    console.log('[Tokoro] Converting image to base64...');
    const { base64, mimeType } = await imageUrlToBase64(imageUrl);
    console.log('[Tokoro] Image converted. MIME type:', mimeType, 'Size:', base64.length, 'bytes');

    const response = await fetch(`${workerUrl}/crawl`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: imageUrl,
        mode: 'image',
        preview: true,
        imageData: base64,
        imageMimeType: mimeType
      })
    });

    console.log('[Tokoro] Response status:', response.status, response.statusText);
    const data = await response.json();
    console.log('[Tokoro] Response data:', data);

    if (response.ok && data.success) {
      console.log('[Tokoro] Success! Extracted', data.events?.length || 0, 'events');
      await chrome.storage.local.set({
        pending_image_extraction: {
          loading: false,
          events: data.events,
          imageSource: imageUrl,
          pageUrl: tab.url,
          imageData: base64,
          imageMimeType: mimeType,
          timestamp: Date.now()
        }
      });
    } else {
      console.error('[Tokoro] Extraction failed:', JSON.stringify(data, null, 2));
      await chrome.storage.local.set({
        pending_image_extraction: {
          loading: false,
          error: data.message || data.error || 'Unknown error',
          imageSource: imageUrl,
          pageUrl: tab.url,
          timestamp: Date.now()
        }
      });
    }
  } catch (error) {
    console.error('[Tokoro] Error during image extraction:', error);
    await chrome.storage.local.set({
      pending_image_extraction: {
        loading: false,
        error: error.message || 'Unknown error occurred',
        imageSource: imageUrl,
        pageUrl: tab.url,
        timestamp: Date.now()
      }
    });
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Get settings
  const { apiKey, workerUrl } = await chrome.storage.sync.get(['apiKey', 'workerUrl']);

  if (!apiKey || !workerUrl) {
    // Open the popup to configure settings
    chrome.action.openPopup();
    return;
  }

  if (info.menuItemId === 'extractFromElement') {
    console.log('[Tokoro] Extract from element triggered');

    // Try to find an image at the last right-click position
    const imageUrl = await findImageAtLastPosition(tab);

    if (!imageUrl) {
      console.error('[Tokoro] No image found at click position');
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon48.png',
        title: 'No Image Found',
        message: 'Could not find an image at the clicked position. Try right-clicking directly on an image.',
        priority: 2
      });
      return;
    }

    console.log('[Tokoro] Found image URL:', imageUrl);
    await handleImageCrawl(imageUrl, tab, apiKey, workerUrl);

  } else if (info.menuItemId === 'crawlThisPage') {
    // Open popup immediately with loading state, then crawl
    await chrome.storage.local.set({
      pending_page_crawl: {
        loading: true,
        pageUrl: tab.url,
        timestamp: Date.now()
      }
    });
    chrome.action.openPopup();

    try {
      // Collect rendered HTML from all frames (main + cross-origin iframes).
      // *://*/* in host_permissions enables injection into cross-origin frames.
      // No world:'MAIN' needed — ISOLATED world reads DOM fine.
      const allFrameResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          var clone = document.documentElement.cloneNode(true);
          // Strip heavy non-content elements to keep payload small; preserve JSON-LD
          clone.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, svg')
            .forEach(el => el.remove());
          return { html: clone.outerHTML, title: document.title, isMainFrame: window === window.top };
        }
      });

      console.log('[Tokoro] executeScript results:', JSON.stringify(
        (allFrameResults || []).map(r => ({
          frameId: r.frameId,
          error: r.error,
          isMainFrame: r?.result?.isMainFrame,
          htmlLength: r?.result?.html?.length,
        }))
      ));

      const mainResult = allFrameResults?.find(r => r?.result?.isMainFrame);
      const iframeResults = (allFrameResults || []).filter(r => r?.result && !r.result.isMainFrame);
      const mainHtml = mainResult?.result?.html || '';
      const pageTitle = mainResult?.result?.title || tab.title || '';
      const iframeHtmls = iframeResults.map(r => r.result.html);
      const combinedHtml = [mainHtml, ...iframeHtmls].filter(Boolean).join('\n');
      const html = combinedHtml.length > 400000 ? combinedHtml.substring(0, 400000) : combinedHtml;
      console.log(`[Tokoro] frames: ${(allFrameResults||[]).length}, iframes captured: ${iframeResults.length}, combinedHtml: ${combinedHtml.length} chars`);

      const response = await fetch(`${workerUrl}/crawl`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: tab.url,
          mode: 'direct',
          preview: true,
          html,
          title: pageTitle,
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        await chrome.storage.local.set({
          pending_page_crawl: {
            loading: false,
            events: data.events,
            preview_token: data.preview_token || null,
            pageUrl: tab.url,
            timestamp: Date.now()
          }
        });
      } else {
        await chrome.storage.local.set({
          pending_page_crawl: {
            loading: false,
            error: data.message || data.error || 'Unknown error',
            pageUrl: tab.url,
            timestamp: Date.now()
          }
        });
      }
    } catch (error) {
      await chrome.storage.local.set({
        pending_page_crawl: {
          loading: false,
          error: error.message,
          pageUrl: tab.url,
          timestamp: Date.now()
        }
      });
    }

  } else if (info.menuItemId === 'crawlThisImage') {
    console.log('[Tokoro] Starting image extraction...');
    console.log('[Tokoro] Image URL:', info.srcUrl);
    await handleImageCrawl(info.srcUrl, tab, apiKey, workerUrl);
  }
});
