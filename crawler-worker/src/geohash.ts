// Simple geohash encoding (copied from worker)

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encode(latitude: number, longitude: number, precision: number = 6): string {
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;

  while (hash.length < precision) {
    if (bit % 2 === 0) {
      const mid = (lngMin + lngMax) / 2;
      if (longitude > mid) {
        ch |= (1 << (4 - (bit % 5)));
        lngMin = mid;
      } else {
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude > mid) {
        ch |= (1 << (4 - (bit % 5)));
        latMin = mid;
      } else {
        latMax = mid;
      }
    }

    bit++;

    if (bit % 5 === 0) {
      hash += BASE32[ch];
      ch = 0;
    }
  }

  return hash;
}
