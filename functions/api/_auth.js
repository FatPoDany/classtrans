/**
 * _auth.js — JWT verification utility for Cloudflare Pages Functions.
 *
 * Verifies Supabase access tokens sent via the Authorization header using the
 * Web Crypto API (no Node.js dependencies).
 *
 * Supabase has moved to asymmetric JWT signing keys: projects using the new
 * API key format (sb_publishable_… / sb_secret_…) issue ES256 (or RS256)
 * access tokens, verified against the project's public JWKS. Older projects
 * issue HS256 tokens verified with the shared SUPABASE_JWT_SECRET.
 *
 * This module supports all three:
 *   - ES256 / RS256  → verified against {SUPABASE_URL}/auth/v1/.well-known/jwks.json
 *   - HS256          → verified with env.SUPABASE_JWT_SECRET (legacy fallback)
 *
 * Usage:
 *   import { verifyAuth, unauthorizedResponse } from './_auth.js';
 *
 *   export async function onRequestPost({ request, env }) {
 *     const user = await verifyAuth(request, env);
 *     if (!user) return unauthorizedResponse();
 *     // user.userId, user.email available
 *   }
 */

// The Supabase project URL. The URL and JWKS are public information (the URL is
// already embedded in the client bundle), so a hard-coded fallback is safe and
// keeps auth working even if SUPABASE_URL is not configured in the environment.
const FALLBACK_SUPABASE_URL = 'https://cguuepaqpotarhhxpllg.supabase.co';

const getSupabaseUrl = (env) =>
  (env && (env.SUPABASE_URL || env.REACT_APP_SUPABASE_URL)) || FALLBACK_SUPABASE_URL;

// Module-scope JWKS cache. Cloudflare reuses isolates between requests, so this
// avoids re-fetching the key set on every call. Keyed by kid.
let jwksCache = null; // { keys: [...], fetchedAt: number }
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

// base64url → Uint8Array
function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// base64url → decoded JSON string
function base64UrlToJson(b64url) {
  const bytes = base64UrlToBytes(b64url);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchJwks(env, force = false) {
  const now = Date.now();
  if (!force && jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const url = `${getSupabaseUrl(env)}/auth/v1/.well-known/jwks.json`;
  const res = await fetch(url, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = await res.json();
  jwksCache = { keys: Array.isArray(data.keys) ? data.keys : [], fetchedAt: now };
  return jwksCache.keys;
}

async function findJwk(env, kid) {
  let keys = await fetchJwks(env);
  let jwk = keys.find((k) => k.kid === kid) || (keys.length === 1 ? keys[0] : null);
  if (!jwk) {
    // Possible key rotation — refetch once, bypassing the cache.
    keys = await fetchJwks(env, true);
    jwk = keys.find((k) => k.kid === kid) || (keys.length === 1 ? keys[0] : null);
  }
  return jwk;
}

function importParams(alg, jwk) {
  if (alg === 'ES256' || jwk.kty === 'EC') {
    return {
      algorithm: { name: 'ECDSA', namedCurve: 'P-256' },
      verifyAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    };
  }
  if (alg === 'RS256' || jwk.kty === 'RSA') {
    return {
      algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      verifyAlgorithm: { name: 'RSASSA-PKCS1-v1_5' },
    };
  }
  return null;
}

async function verifyAsymmetric(env, parts, header) {
  const jwk = await findJwk(env, header.kid);
  if (!jwk) {
    console.error('No matching JWK for kid', header.kid);
    return false;
  }
  const params = importParams(header.alg, jwk);
  if (!params) {
    console.error('Unsupported JWK type/alg', jwk.kty, header.alg);
    return false;
  }
  const key = await crypto.subtle.importKey('jwk', jwk, params.algorithm, false, ['verify']);
  const signature = base64UrlToBytes(parts[2]);
  const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  return crypto.subtle.verify(params.verifyAlgorithm, key, signature, data);
}

async function verifyHs256(env, parts) {
  const secret = env && env.SUPABASE_JWT_SECRET;
  if (!secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const signature = base64UrlToBytes(parts[2]);
  const data = encoder.encode(parts[0] + '.' + parts[1]);
  return crypto.subtle.verify('HMAC', key, signature, data);
}

/**
 * Verify a Supabase JWT token.
 * @param {Request} request - The incoming request
 * @param {object} env - Cloudflare environment
 * @returns {Promise<{userId: string, email: string} | null>} Decoded user info or null
 */
export async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const header = base64UrlToJson(parts[0]);
    const payload = base64UrlToJson(parts[1]);

    // Check expiration (with a small clock-skew tolerance).
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000) - 5) return null;

    let valid = false;
    if (header.alg === 'HS256') {
      valid = await verifyHs256(env, parts);
    } else if (header.alg === 'ES256' || header.alg === 'RS256') {
      valid = await verifyAsymmetric(env, parts, header);
    } else {
      console.error('Unsupported JWT alg:', header.alg);
      return null;
    }

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
