// Geohash implementation for Cloudflare Workers
// Based on geohash.org algorithm

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encode(latitude: number, lng: number, precision: number = 6): string {
	let lat = latitude;
	let lon = lng;
	let idx = 0;
	let bit = 0;
	let evenBit = true;
	let geohash = '';

	let latMin = -90, latMax = 90;
	let lonMin = -180, lonMax = 180;

	while (geohash.length < precision) {
		if (evenBit) {
			// longitude
			const lonMid = (lonMin + lonMax) / 2;
			if (lon > lonMid) {
				idx = (idx << 1) + 1;
				lonMin = lonMid;
			} else {
				idx = idx << 1;
				lonMax = lonMid;
			}
		} else {
			// latitude
			const latMid = (latMin + latMax) / 2;
			if (lat > latMid) {
				idx = (idx << 1) + 1;
				latMin = latMid;
			} else {
				idx = idx << 1;
				latMax = latMid;
			}
		}
		evenBit = !evenBit;

		if (++bit === 5) {
			geohash += BASE32[idx];
			bit = 0;
			idx = 0;
		}
	}

	return geohash;
}

// Get neighboring geohashes (8 neighbors + center = 9 total)
export function neighbors(geohash: string): string[] {
	const result: string[] = [];

	// Neighbor calculation tables
	const neighborMap: Record<string, Record<string, string>> = {
		right: { even: 'bc01fg45238967deuvhjyznpkmstqrwx', odd: 'p0r21436x8zb9dcf5h7kjnmqesgutwvy' },
		left: { even: '238967debc01fg45kmstqrwxuvhjyznp', odd: '14365h7k9dcfesgujnmqp0r2twvyx8zb' },
		top: { even: 'p0r21436x8zb9dcf5h7kjnmqesgutwvy', odd: 'bc01fg45238967deuvhjyznpkmstqrwx' },
		bottom: { even: '14365h7k9dcfesgujnmqp0r2twvyx8zb', odd: '238967debc01fg45kmstqrwxuvhjyznp' }
	};

	const borderMap: Record<string, Record<string, string>> = {
		right: { even: 'bcfguvyz', odd: 'prxz' },
		left: { even: '0145hjnp', odd: '028b' },
		top: { even: 'prxz', odd: 'bcfguvyz' },
		bottom: { even: '028b', odd: '0145hjnp' }
	};

	function getNeighbor(hash: string, direction: string): string {
		if (!hash) return '';

		const lastChar = hash[hash.length - 1];
		let parent = hash.slice(0, -1);
		const type = hash.length % 2 === 0 ? 'even' : 'odd';

		// Check if we're at a border
		if (borderMap[direction][type].indexOf(lastChar) !== -1 && parent) {
			parent = getNeighbor(parent, direction);
		}

		// Replace last character
		const charIndex = BASE32.indexOf(lastChar);
		const neighborIndex = neighborMap[direction][type].indexOf(lastChar);

		return parent + BASE32[neighborIndex];
	}

	// Get all 8 neighbors
	const top = getNeighbor(geohash, 'top');
	const bottom = getNeighbor(geohash, 'bottom');
	const right = getNeighbor(geohash, 'right');
	const left = getNeighbor(geohash, 'left');

	result.push(
		top,
		bottom,
		right,
		left,
		getNeighbor(top, 'right'),
		getNeighbor(top, 'left'),
		getNeighbor(bottom, 'right'),
		getNeighbor(bottom, 'left')
	);

	return result.filter(h => h); // Remove empty strings
}
