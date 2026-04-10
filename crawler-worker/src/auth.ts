/**
 * Authentication middleware for the crawler worker
 * Validates API keys from Authorization header
 */

export interface AuthResult {
  authorized: boolean;
  error?: string;
}

/**
 * Validates the API key from the request
 * @param request - The incoming request
 * @param allowedKeys - Comma-separated list of allowed API keys
 * @returns AuthResult indicating if the request is authorized
 */
export function validateApiKey(request: Request, allowedKeys: string): AuthResult {
  // Extract Authorization header
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return {
      authorized: false,
      error: 'Missing Authorization header'
    };
  }

  // Extract bearer token
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {
      authorized: false,
      error: 'Invalid Authorization header format. Use: Bearer <api_key>'
    };
  }

  const apiKey = match[1];

  // Check if the API key is in the allowed list
  const allowedKeysList = allowedKeys.split(',').map(k => k.trim());

  if (!allowedKeysList.includes(apiKey)) {
    return {
      authorized: false,
      error: 'Invalid API key'
    };
  }

  return { authorized: true };
}

/**
 * Creates an unauthorized response
 * @param error - Error message
 * @returns Response with 401 status
 */
export function unauthorizedResponse(error: string): Response {
  return new Response(
    JSON.stringify({
      error: 'Unauthorized',
      message: error
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="Tokoro Crawler API"'
      }
    }
  );
}
