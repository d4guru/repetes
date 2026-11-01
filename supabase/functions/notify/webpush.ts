// Envoi de notifications Web Push (RFC 8291 « aes128gcm » + signature VAPID RFC 8292)
// Uniquement WebCrypto : fonctionne dans Deno (Supabase Edge Functions) et Node 20+.

const enc = new TextEncoder();

export function b64uToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64u(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

export interface PushSubscription { endpoint: string; p256dh: string; auth: string }
export interface Vapid { publicKey: string; privateKey: string; subject: string }

// Chiffre le contenu pour un abonnement (corps aes128gcm complet, en-tête inclus)
export async function encryptPayload(sub: PushSubscription, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(sub.p256dh);
  const authSecret = b64uToBytes(sub.auth);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(payload, new Uint8Array([2])); // 0x02 = dernier enregistrement, sans remplissage
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  const rs = new Uint8Array([0, 0, 16, 0]); // taille d'enregistrement 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Jeton VAPID (JWT ES256) pour le service de push de l'abonnement
export async function vapidAuthHeader(endpoint: string, vapid: Vapid): Promise<string> {
  const pub = b64uToBytes(vapid.publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: vapid.privateKey,
    x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapid.subject,
  })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${bytesToB64u(sig)}, k=${vapid.publicKey}`;
}

// Envoie une notification ; renvoie le code HTTP (404/410 = abonnement expiré)
export async function sendPush(sub: PushSubscription, data: unknown, vapid: Vapid, ttl = 86400): Promise<number> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(data)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': String(ttl),
      'Urgency': 'high',
      'Authorization': await vapidAuthHeader(sub.endpoint, vapid),
    },
    body,
  });
  try { await res.text(); } catch (_) { /* corps ignoré */ }
  return res.status;
}
