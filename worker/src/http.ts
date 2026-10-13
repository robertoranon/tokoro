// CORS headers for all responses. X-Pubkey/X-Signature/X-Timestamp carry the
// Ed25519 auth of the member and admin endpoints.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, X-Pubkey, X-Signature, X-Timestamp',
};

export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

/** Largest request body accepted by the signed member/admin endpoints. */
export const MAX_BODY_BYTES = 8 * 1024;

export function payloadTooLarge(): Response {
  return jsonResponse({ error: 'Payload too large' }, 413);
}

/** True when a Content-Length header announces more than maxBytes. */
export function contentLengthTooLarge(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES
): boolean {
  const len = (request.headers.get('Content-Length') || '').trim();
  return /^\d+$/.test(len) && Number(len) > maxBytes;
}

/**
 * The request body as text, or a 413 Response when it is larger than
 * maxBytes (announced by Content-Length, or measured after reading).
 */
export async function readBodyLimited(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES
): Promise<string | Response> {
  if (contentLengthTooLarge(request, maxBytes)) return payloadTooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes)
    return payloadTooLarge();
  return text;
}
