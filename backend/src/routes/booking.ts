import { fail, json, MESSAGES, type ApiRequest, type Reply } from '../lib/http';

/** Session types the booking form offers (RATES in site/gallery.html), plus "other". */
export const SESSION_TYPES: Readonly<Record<string, string>> = {
  headshots: 'Headshots',
  portraits: 'Portraits',
  senior: 'Graduation & senior',
  engagement: 'Engagement',
  events: 'Events & sports',
  other: 'Something else',
};

export const LIMITS = { name: 100, email: 254, message: 4000 } as const;

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Booking {
  name: string;
  email: string;
  type: string;
  date: string;
  message: string;
}

type Parsed = { ok: true; booking: Booking; spam: boolean } | { ok: false; reply: Reply };

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
/** One line, no control characters: these values end up in an email subject or header. */
const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

export function parseBooking(body: unknown, today: Date): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reply: fail('bad_request', MESSAGES.badRequest) };
  }
  const input = body as Record<string, unknown>;
  const bad = (field: string, message: string): Parsed => ({ ok: false, reply: fail('bad_request', message, field) });

  const name = oneLine(text(input.name));
  if (!name) return bad('name', 'Please add your name.');
  if (name.length > LIMITS.name) return bad('name', 'That name is too long.');

  const email = text(input.email);
  if (!EMAIL.test(email) || email.length > LIMITS.email) return bad('email', 'Please check your email address.');

  const type = text(input.type) || 'other';
  if (!(type in SESSION_TYPES)) return bad('type', 'Please pick a session type.');

  const date = text(input.date);
  if (date) {
    const parsed = DATE.test(date) ? new Date(`${date}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      return bad('date', 'Please check the date.');
    }
    // A day of slack for time zones: "today" in Hawaii is yesterday in UTC.
    if (parsed.getTime() < today.getTime() - 2 * 86_400_000) return bad('date', 'Please pick a date that is still ahead.');
  }

  const message = text(input.message).replace(/\r\n?/g, '\n');
  if (message.length > LIMITS.message) return { ok: false, reply: fail('payload_too_large', MESSAGES.tooLarge, 'message') };

  // Honeypot: a field people never see. Bots that fill every input get a normal "sent" answer and no email.
  const spam = text(input.website).length > 0;
  return { ok: true, booking: { name, email, type, date, message }, spam };
}

export function bookingEmail(booking: Booking, stage: string): { subject: string; text: string } {
  const session = SESSION_TYPES[booking.type];
  const tag = stage && stage !== 'prod' ? `[${stage}] ` : '';
  return {
    subject: `${tag}Booking request: ${booking.name}, ${session}`,
    text: [
      `${booking.name} asked to book a session through the website.`,
      '',
      `Name: ${booking.name}`,
      `Email: ${booking.email}`,
      `Session: ${session}`,
      `Preferred date: ${booking.date || 'not given'}`,
      '',
      booking.message || '(no message)',
      '',
      `Reply to this email to answer ${booking.name} directly.`,
    ].join('\n'),
  };
}

/** `POST /api/booking`: emails the request to the AWS account's own address, with the visitor as Reply-To. */
export async function createBooking({ body, env, now, mailer }: ApiRequest): Promise<Reply> {
  const parsed = parseBooking(body, now);
  if (!parsed.ok) return parsed.reply;
  if (parsed.spam) return json(202, { ok: true });

  const to = env.BOOKING_EMAIL ?? '';
  if (!EMAIL.test(to)) throw new Error('BOOKING_EMAIL is not set to an email address');

  const { subject, text: emailText } = bookingEmail(parsed.booking, env.STAGE ?? '');
  await mailer().send({
    from: `Nathan Jones Photography <${to}>`,
    to,
    replyTo: parsed.booking.email,
    subject,
    text: emailText,
  });
  return json(202, { ok: true });
}
