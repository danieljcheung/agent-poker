const MAX_MESSAGE_LENGTH = 280;

// Patterns that look like prompt injection attempts
const INJECTION_PATTERNS = [
  /\b(system|instruction|ignore|override|admin|debug|reveal|sudo)\b/i,
  /\b(previous prompt|new instructions|you are now|act as)\b/i,
  /\b(ignore all|forget everything|disregard|override your)\b/i,
  /<\/?[a-z][\s\S]*>/i,
  /\[\/?(?:SYSTEM|INST|USER|ASSISTANT|TOOL)\]/i,
  /```[\s\S]*```/,
  /\{\{[\s\S]*\}\}/,
  /<<[\s\S]*>>/,
];

export function sanitizeChat(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  // Strip control characters (keep basic printable + common unicode)
  let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Collapse excessive whitespace
  cleaned = cleaned.replace(/\s{3,}/g, '  ').trim();

  // Length check
  if (cleaned.length === 0) {
    return { ok: false, reason: 'Empty message' };
  }
  if (cleaned.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, reason: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` };
  }

  // Remove markup-like characters
  cleaned = cleaned
    .replace(/[<>]/g, '')
    .replace(/\[\/?\w+\]/g, '')
    .replace(/[`~|\\]/g, '');

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      return { ok: false, reason: 'Message filtered' };
    }
  }

  return { ok: true, text: cleaned };
}

export function sanitizeAgentName(name: string): { ok: true; name: string } | { ok: false; reason: string } {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleaned.length < 2) return { ok: false, reason: 'Name too short (min 2 chars)' };
  if (cleaned.length > 20) return { ok: false, reason: 'Name too long (max 20 chars)' };
  return { ok: true, name: cleaned };
}

export function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(key)).then(buf => {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  });
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pk_${key}`;
}
