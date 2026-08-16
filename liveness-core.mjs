import { lookup } from 'dns/promises';

// ---------------------------------------------------------------------------
// SSRF guard — defense in depth for check-liveness.mjs's page.goto(url).
// Chromium's page.goto() accepts file:// URLs and any host/port a plain http
// client would, so an unvalidated URL here is a local-file-read + internal-
// network SSRF vector. Resolving the hostname (not just pattern-matching it)
// is what catches DNS rebinding — a hostname that looks public but resolves
// to a private/loopback address is still rejected.
// ---------------------------------------------------------------------------
function isPrivateOrLoopbackIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed — fail closed
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + cloud metadata)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isPrivateOrLoopbackIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — check the embedded IPv4 address too
    const mapped = lower.split(':').pop();
    if (mapped.includes('.')) return isPrivateOrLoopbackIPv4(mapped);
  }
  return false;
}

export async function assertSafeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Malformed URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === 'metadata.google.internal') {
    throw new Error('This hostname is not allowed.');
  }
  let resolved;
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve hostname.');
  }
  for (const { address, family } of resolved) {
    const unsafe = family === 6 ? isPrivateOrLoopbackIPv6(address) : isPrivateOrLoopbackIPv4(address);
    if (unsafe) {
      throw new Error('This URL resolves to a non-public address and cannot be checked.');
    }
  }
}

const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

const MIN_CONTENT_CHARS = 300;

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({ status = 0, finalUrl = '', bodyText = '', applyControls = [] } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', reason: 'visible apply control detected' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', reason: 'content present but no visible apply control found' };
}
