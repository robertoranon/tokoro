import * as ed25519 from '@noble/ed25519';

// Configure SHA-512 for Cloudflare Workers (uses Web Crypto API)
ed25519.etc.sha512Async = async (...messages: Uint8Array[]) => {
	const combined = new Uint8Array(messages.reduce((acc, m) => acc + m.length, 0));
	let offset = 0;
	for (const m of messages) { combined.set(m, offset); offset += m.length; }
	const hashBuffer = await crypto.subtle.digest('SHA-512', combined);
	return new Uint8Array(hashBuffer);
};

export async function verifyEventSignature(event: any): Promise<boolean> {
	try {
		// Create canonical event data for signing (excluding signature itself)
		// MUST match exactly what the client signs
		const eventData = {
			pubkey: event.pubkey,
			title: event.title,
			description: event.description || '',
			url: event.url || '',
			venue_name: event.venue_name || '',
			address: event.address || '',
			lat: event.lat,
			lng: event.lng,
			start_time: event.start_time,
			end_time: event.end_time,
			category: event.category,
			tags: event.tags || [],
			created_at: event.created_at
		};

		// Hash the event data to get the message that was signed
		const message = await hashEventData(eventData);

		// Convert hex strings to Uint8Array
		const signature = hexToBytes(event.signature);
		const publicKey = hexToBytes(event.pubkey);

		// Verify the signature (use verifyAsync for Cloudflare Workers)
		const result = await ed25519.verifyAsync(signature, hexToBytes(message), publicKey);
		return result;
	} catch (error) {
		console.error('Signature verification error:', error);
		return false;
	}
}

export async function verifyDeleteSignature(
	eventId: string,
	pubkey: string,
	signature: string
): Promise<boolean> {
	try {
		// For delete operations, we sign the event ID
		const message = hexToBytes(eventId);
		const sig = hexToBytes(signature);
		const publicKey = hexToBytes(pubkey);

		return await ed25519.verifyAsync(sig, message, publicKey);
	} catch (error) {
		console.error('Delete signature verification error:', error);
		return false;
	}
}

async function hashEventData(eventData: any): Promise<string> {
	const canonical = JSON.stringify(eventData);
	const encoder = new TextEncoder();
	const data = encoder.encode(canonical);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

export async function verifyAdminSignature(
	targetPubkey: string,
	adminPubkey: string,
	signature: string
): Promise<boolean> {
	try {
		const encoder = new TextEncoder();
		const messageBytes = encoder.encode('blocklist:' + targetPubkey);
		const hashBuffer = await crypto.subtle.digest('SHA-256', messageBytes);
		const message = new Uint8Array(hashBuffer);

		const sig = hexToBytes(signature);
		const publicKey = hexToBytes(adminPubkey);

		return await ed25519.verifyAsync(sig, message, publicKey);
	} catch (error) {
		console.error('Admin signature verification error:', error);
		return false;
	}
}
