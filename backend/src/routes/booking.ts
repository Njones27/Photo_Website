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
/** What a time input sends: 24-hour HH:MM, sometimes with seconds. */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d(\.\d+)?)?$/;

export interface Booking {
  name: string;
  email: string;
  type: string;
  date: string;
  /** 24-hour HH:MM. */
  time: string;
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
  if (!date) return bad('date', 'Please pick a date.');
  const parsed = DATE.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return bad('date', 'Please check the date.');
  }
  // A day of slack for time zones: "today" in Hawaii is yesterday in UTC.
  if (parsed.getTime() < today.getTime() - 2 * 86_400_000) return bad('date', 'Please pick a date that is still ahead.');

  const rawTime = text(input.time);
  if (!rawTime) return bad('time', 'Please pick a time.');
  if (!TIME.test(rawTime)) return bad('time', 'Please check the time.');
  const time = rawTime.slice(0, 5);

  const message = text(input.message).replace(/\r\n?/g, '\n');
  if (!message) return bad('message', 'Please tell me a little about what you have in mind.');
  if (message.length > LIMITS.message) return { ok: false, reply: fail('payload_too_large', MESSAGES.tooLarge, 'message') };

  // Honeypot: a field people never see. Bots that fill every input get a normal "sent" answer and no email.
  const spam = text(input.website).length > 0;
  return { ok: true, booking: { name, email, type, date, time, message }, spam };
}

/** "14:30" as "2:30 PM", the way people write it in an email. */
export function clockTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
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
      `Preferred date: ${booking.date}`,
      `Preferred time: ${clockTime(booking.time)}`,
      '',
      booking.message,
      '',
      `Reply to this email to answer ${booking.name} directly.`,
    ].join('\n'),
  };
}

/**
 * The visitor's copy. It repeats only values the form picked from a list (session, date, and time), never the name or the
 * message, so nobody can use the form to send their own text to someone else's inbox.
 */
export function confirmationEmail(booking: Booking, stage: string): { subject: string; text: string } {
  const tag = stage && stage !== 'prod' ? `[${stage}] ` : '';
  return {
    subject: `${tag}Your booking request with Nathan Jones Photography`,
    text: [
      'Hi,',
      '',
      'Thanks for your booking request. It reached me, and I will reply by email soon to talk through the details.',
      '',
      `Session: ${SESSION_TYPES[booking.type]}`,
      `Preferred date: ${booking.date}`,
      `Preferred time: ${clockTime(booking.time)}`,
      '',
      'If you want to add anything, just reply to this email.',
      '',
      'Nathan Jones',
      '',
      'You are getting this because this address was entered on the booking form at nathanjonesphoto.co. '
        + 'If that was not you, you can ignore it.',
    ].join('\n'),
  };
}

/**
 * `POST /api/booking`: emails the request to the AWS account's own address with the visitor as Reply-To, then sends
 * the visitor a confirmation. A failed confirmation is logged as a warning and does not fail the request, because
 * Nathan already has it (and SES in sandbox mode refuses unverified recipients, so beta usually can't send it).
 */
export async function createBooking({ body, env, now, mailer, log }: ApiRequest): Promise<Reply> {
  const parsed = parseBooking(body, now);
  if (!parsed.ok) {
    log('info', 'Booking rejected', { status: parsed.reply.statusCode, field: JSON.parse(parsed.reply.body).field });
    return parsed.reply;
  }
  if (parsed.spam) {
    log('info', 'Booking dropped by the spam trap');
    return json(202, { ok: true });
  }

  const owner = env.BOOKING_EMAIL ?? '';
  if (!EMAIL.test(owner)) throw new Error('BOOKING_EMAIL is not set to an email address');
  const stage = env.STAGE ?? '';
  const { booking } = parsed;
  const from = `Nathan Jones Photography <${owner}>`;

  await mailer().send({ from, to: owner, replyTo: booking.email, ...bookingEmail(booking, stage) });
  log('info', 'Booking sent', { type: booking.type });

  try {
    await mailer().send({ from, to: booking.email, replyTo: owner, ...confirmationEmail(booking, stage) });
    log('info', 'Confirmation sent');
  } catch (err) {
    log('warn', 'Confirmation not sent', { error: err instanceof Error ? err.message : String(err) });
  }
  return json(202, { ok: true });
}
