/**
 * Contact-form Worker, showcase version.
 *
 * Adapted from the Worker in front of my portfolio site. POST /api/contact:
 *   1. honeypot check,
 *   2. verify the Cloudflare Turnstile token server-side (siteverify),
 *   3. re-validate the fields,
 *   4. send the message through a mail API, with an optional voice recording
 *      attached, so nothing is stored.
 *
 * Expects four Worker secrets: TURNSTILE_SECRET, RESEND_API_KEY, MAIL_FROM, MAIL_TO.
 * Everything else falls through to the static assets binding.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND = 'https://api.resend.com/emails';

const MAX_MESSAGE = 1000;
const MIN_MESSAGE = 10;
const MAX_FIELD = 200;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const VOICE_TYPES = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function verifyTurnstile(token, ip, secret) {
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  const res = await fetch(SITEVERIFY, { method: 'POST', body });
  if (!res.ok) return { ok: false, codes: ['siteverify-http-' + res.status] };

  const data = await res.json();
  return { ok: data.success === true, codes: data['error-codes'] || [] };
}

async function handleContact(request, env) {
  const missing = ['TURNSTILE_SECRET', 'RESEND_API_KEY', 'MAIL_FROM', 'MAIL_TO'].filter((k) => !env[k]);
  if (missing.length) {
    console.error('Contact form misconfigured, missing:', missing.join(','));
    return json({ success: false, message: 'Form is not configured. Please email me directly.' }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ success: false, message: 'Malformed submission.' }, 400);
  }

  // Honeypot: real people never fill this. Report success so bots learn nothing.
  if (form.get('botcheck')) return json({ success: true, message: 'Message sent successfully!' });

  const token = form.get('cf-turnstile-response');
  if (!token) {
    return json({ success: false, message: 'Please complete the captcha verification.' }, 400);
  }

  const ip = request.headers.get('CF-Connecting-IP');
  const check = await verifyTurnstile(token, ip, env.TURNSTILE_SECRET);
  if (!check.ok) {
    console.log('Turnstile rejected:', check.codes.join(','));
    return json({ success: false, message: 'Captcha verification failed. Please try again.' }, 403);
  }

  // Validate here too, not just in the browser.
  const name = (form.get('name') || '').toString().trim();
  const email = (form.get('email') || '').toString().trim();
  const company = (form.get('company') || '').toString().trim();
  const message = (form.get('message') || '').toString().trim();

  if (!name || name.length > MAX_FIELD) {
    return json({ success: false, message: 'Please enter your name.' }, 400);
  }
  if (!email || email.length > MAX_FIELD || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ success: false, message: 'Please enter a valid email address.' }, 400);
  }
  if (message.length < MIN_MESSAGE || message.length > MAX_MESSAGE) {
    return json({
      success: false,
      message: `Message must be between ${MIN_MESSAGE} and ${MAX_MESSAGE} characters.`,
    }, 400);
  }

  let attachments;
  const voice = form.get('voice');
  if (voice instanceof File && voice.size > 0) {
    const ext = VOICE_TYPES[voice.type.split(';')[0].trim().toLowerCase()];
    if (!ext || voice.size > MAX_VOICE_BYTES) {
      return json({ success: false, message: 'Voice recording must be audio under 2 minutes.' }, 400);
    }
    attachments = [{ filename: `voice-message.${ext}`, content: toBase64(await voice.arrayBuffer()) }];
  }

  // Plain text only: nothing the sender writes is ever interpreted as markup.
  const text = [
    `Name:    ${name}`,
    `Email:   ${email}`,
    company ? `Company: ${company}` : null,
    '',
    message,
    attachments ? '\n[Voice message attached]' : null,
    '',
    '—',
    `Sent from bryceboldenscott.com${ip ? ` · ${ip}` : ''}`,
  ].filter((line) => line !== null).join('\n');

  let res;
  try {
    res = await fetch(RESEND, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        reply_to: email,
        subject: `New message from ${name} — bryceboldenscott.com`,
        text,
        attachments,
      }),
    });
  } catch (err) {
    console.error('Resend request failed:', err);
    return json({ success: false, message: 'Could not reach the mail service. Please try again.' }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('Resend rejected:', res.status, detail.slice(0, 300));
    return json({ success: false, message: 'Could not send the message. Please try again.' }, 502);
  }

  return json({ success: true, message: 'Message sent successfully!' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') {
        return json({ success: false, message: 'Method not allowed.' }, 405);
      }
      return handleContact(request, env);
    }

    // Everything else is the static site.
    return env.ASSETS.fetch(request);
  },
};
