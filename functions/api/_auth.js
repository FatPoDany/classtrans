/**
 * _auth.js — JWT verification utility for Cloudflare Pages Functions.
 *
 * Verifies Supabase JWT tokens (HS256) sent via the Authorization header
 * using the Web Crypto API (no Node.js dependencies).
 *
 * Usage:
 *   import { verifyAuth, unauthorizedResponse } from './_auth.js';
 *
 *   export async function onRequestGet({ request, env }) {
 *     const user = await verifyAuth(request, env);
 *     if (!user) return unauthorizedResponse();
 *     // user.userId, user.email available
 *   }
 */

/**
 * Verify a Supabase JWT token using the HS256 algorithm.
 * @param {Request} request - The incoming request
 * @param {object} env - Cloudflare environment (env.SUPABASE_JWT_SECRET)
 * @returns {Promise<{userId: string, email: string} | null>} Decoded user info or null
 */
export async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const secret = env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error('SUPABASE_JWT_SECRET not configured');
    return null;
  }

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Decode header and payload (base64url → base64 → JSON)
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

    // Only HS256 is supported (Supabase default)
    if (header.alg !== 'HS256') return null;

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Verify signature using Web Crypto API
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signatureInput = encoder.encode(parts[0] + '.' + parts[1]);
    const signature = Uint8Array.from(
      atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify('HMAC', key, signature, signatureInput);
    if (!valid) return null;

    return {
      userId: payload.sub,
      email: payload.email,
    };
  } catch (err) {
    console.error('JWT verification failed:', err);
    return null;
  }
}

/**
 * Helper: return a 401 Unauthorized JSON response.
 * @returns {Response}
 */
export function unauthorizedResponse() {
  return new Response(
    JSON.stringify({ error: 'Unauthorized' }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
