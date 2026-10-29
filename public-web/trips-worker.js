'use strict';

/**
 * Web Worker for trips.html: runs the planner off the main thread.
 * In: { gen, input } (the computeTrips argument). Out: { gen, trips } or
 * { gen, error }. The page ignores replies whose gen is not the latest.
 */
importScripts('./trips.js');

self.onmessage = e => {
  const { gen, input } = e.data || {};
  try {
    self.postMessage({ gen, trips: self.TokoroTrips.computeTrips(input) });
  } catch (err) {
    self.postMessage({ gen, error: String(err) });
  }
};
