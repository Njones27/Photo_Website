import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { createHandler, MAX_BODY_BYTES } from '../src/handler';
import type { Mailer } from '../src/lib/http';
import { LIMITS } from '../src/routes/booking';

const SECRET = 'a'.repeat(64);
const NOW = new Date('2026-11-09T18:00:00Z');
const OWNER = 'owner@example.com';

function event(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers: { 'x-origin-verify': SECRET, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method }, requestId: 'req-1' },
  } as unknown as APIGatewayProxyEventV2;
}

function setup(env: Record<string, string> = {}) {
  const sent: Parameters<Mailer['send']>[0][] = [];
  const mailer: Mailer = { send: vi.fn(async (m) => { sent.push(m); }) };
  const logError = vi.fn();
  const log = vi.fn();
  const handler = createHandler({
    env: { ORIGIN_VERIFY_SECRET: SECRET, BOOKING_EMAIL: OWNER, STAGE: 'prod', APP_VERSION: 'abc123', ...env },
    mailer,
    now: () => NOW,
    logError,
    log,
  });
  return { handler, sent, mailer, logError, log };
}

const good = {
  name: 'Jamie Doe',
  email: 'jamie@example.org',
  type: 'senior',
  date: '2026-12-01',
  message: 'Golden hour at the arboretum.\nTwo outfits.',
};

const parse = (reply: { body: string }) => JSON.parse(reply.body);

describe('origin verify', () => {
  it('refuses requests without the CloudFront header', async () => {
    const { handler, sent } = setup();
    const reply = await handler(event('POST', '/api/booking', good, { 'x-origin-verify': 'nope' }));
    expect(reply.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('fails closed and logs when the secret is missing', async () => {
    const { handler, logError } = setup({ ORIGIN_VERIFY_SECRET: '' });
    expect((await handler(event('GET', '/api/health'))).statusCode).toBe(403);
    expect(logError).toHaveBeenCalledOnce();
  });
});

describe('GET /api/health', () => {
  it('reports ok with the stage and version, never cached', async () => {
    const { handler } = setup();
    const reply = await handler(event('GET', '/api/health'));
    expect(reply.statusCode).toBe(200);
    expect(parse(reply)).toMatchObject({ ok: true, stage: 'prod', version: 'abc123' });
    expect(reply.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/booking', () => {
  it('emails the account address, from itself, with the visitor as Reply-To', async () => {
    const { handler, sent } = setup();
    const reply = await handler(event('POST', '/api/booking', good));
    expect(reply.statusCode).toBe(202);
    expect(parse(reply)).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      from: `Nathan Jones Photography <${OWNER}>`,
      to: OWNER,
      replyTo: 'jamie@example.org',
      subject: 'Booking request: Jamie Doe, Graduation & senior',
    });
    expect(sent[0].text).toContain('Preferred date: 2026-12-01');
    expect(sent[0].text).toContain('Golden hour at the arboretum.\nTwo outfits.');
  });

  it('sends the visitor a confirmation that replies to Nathan and repeats none of their text', async () => {
    const { handler, sent, log } = setup();
    await handler(event('POST', '/api/booking', { ...good, name: 'Buy pills at spam.example' }));
    expect(sent[1]).toMatchObject({
      from: `Nathan Jones Photography <${OWNER}>`,
      to: 'jamie@example.org',
      replyTo: OWNER,
      subject: 'Your booking request with Nathan Jones Photography',
    });
    expect(sent[1].text).toContain('Session: Graduation & senior');
    expect(sent[1].text).toContain('Preferred date: 2026-12-01');
    expect(sent[1].text).not.toContain('spam.example');
    expect(sent[1].text).not.toContain('Golden hour');
    expect(log).toHaveBeenCalledWith('info', 'Confirmation sent', expect.objectContaining({ route: 'POST /api/booking' }));
  });

  it('still answers 202 and only warns when the confirmation fails (SES sandbox)', async () => {
    const { handler, mailer, sent, log, logError } = setup();
    vi.mocked(mailer.send)
      .mockImplementationOnce(async (m) => { sent.push(m); })
      .mockRejectedValueOnce(new Error('MessageRejected: Email address is not verified'));
    const reply = await handler(event('POST', '/api/booking', good));
    expect(reply.statusCode).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(OWNER);
    expect(log).toHaveBeenCalledWith('warn', 'Confirmation not sent', expect.objectContaining({
      error: expect.stringContaining('not verified'),
    }));
    expect(logError).not.toHaveBeenCalled();
  });

  it('logs why a booking was rejected or dropped', async () => {
    const { handler, log } = setup();
    await handler(event('POST', '/api/booking', { ...good, date: '2026-01-01' }));
    expect(log).toHaveBeenCalledWith('info', 'Booking rejected', expect.objectContaining({ status: 400, field: 'date' }));
    await handler(event('POST', '/api/booking', { ...good, website: 'x' }));
    expect(log).toHaveBeenCalledWith('info', 'Booking dropped by the spam trap', expect.anything());
  });

  it('tags the subject with the stage outside prod', async () => {
    const { handler, sent } = setup({ STAGE: 'beta' });
    await handler(event('POST', '/api/booking', good));
    expect(sent[0].subject).toBe('[beta] Booking request: Jamie Doe, Graduation & senior');
    expect(sent[1].subject).toBe('[beta] Your booking request with Nathan Jones Photography');
  });

  it('accepts a request with only a name and email', async () => {
    const { handler, sent } = setup();
    const reply = await handler(event('POST', '/api/booking', { name: 'Sam', email: 'sam@example.com' }));
    expect(reply.statusCode).toBe(202);
    expect(sent[0].subject).toBe('Booking request: Sam, Something else');
    expect(sent[0].text).toContain('Preferred date: not given');
  });

  it('keeps line breaks and control characters out of the subject', async () => {
    const { handler, sent } = setup();
    await handler(event('POST', '/api/booking', { ...good, name: 'Eve\r\nBcc: x@evil.test' }));
    expect(sent[0].subject).toBe('Booking request: Eve Bcc: x@evil.test, Graduation & senior');
  });

  it.each([
    ['a missing name', { ...good, name: '  ' }, 'name'],
    ['a bad email', { ...good, email: 'jamie' }, 'email'],
    ['an email with two addresses', { ...good, email: 'a@b.co, c@d.co' }, 'email'],
    ['an unknown session type', { ...good, type: 'wedding' }, 'type'],
    ['an impossible date', { ...good, date: '2026-02-30' }, 'date'],
    ['a past date', { ...good, date: '2026-01-01' }, 'date'],
    ['a long name', { ...good, name: 'x'.repeat(LIMITS.name + 1) }, 'name'],
  ])('rejects %s and sends nothing', async (_, body, field) => {
    const { handler, sent } = setup();
    const reply = await handler(event('POST', '/api/booking', body));
    expect(reply.statusCode).toBe(400);
    expect(parse(reply).field).toBe(field);
    expect(sent).toHaveLength(0);
  });

  it('rejects an over-long message with 413', async () => {
    const { handler } = setup();
    const reply = await handler(event('POST', '/api/booking', { ...good, message: 'x'.repeat(LIMITS.message + 1) }));
    expect(reply.statusCode).toBe(413);
  });

  it('rejects a body over the size cap before parsing it', async () => {
    const { handler } = setup();
    const reply = await handler(event('POST', '/api/booking', 'x'.repeat(MAX_BODY_BYTES + 1)));
    expect(reply.statusCode).toBe(413);
  });

  it('rejects bodies that are not a JSON object', async () => {
    const { handler } = setup();
    expect((await handler(event('POST', '/api/booking', '{nope'))).statusCode).toBe(400);
    expect((await handler(event('POST', '/api/booking', [good]))).statusCode).toBe(400);
    expect((await handler(event('POST', '/api/booking'))).statusCode).toBe(400);
  });

  it('answers a filled honeypot like a success but sends nothing', async () => {
    const { handler, sent } = setup();
    const reply = await handler(event('POST', '/api/booking', { ...good, website: 'http://spam.example' }));
    expect(reply.statusCode).toBe(202);
    expect(sent).toHaveLength(0);
  });

  it('turns an SES failure into a friendly 500 and logs it', async () => {
    const { handler, mailer, logError } = setup();
    vi.mocked(mailer.send).mockRejectedValueOnce(new Error('MessageRejected: Email address is not verified'));
    const reply = await handler(event('POST', '/api/booking', good));
    expect(reply.statusCode).toBe(500);
    expect(parse(reply).message).not.toMatch(/verified/);
    expect(logError).toHaveBeenCalledWith('Unhandled error', expect.objectContaining({ route: 'POST /api/booking' }));
  });

  it('fails loudly when BOOKING_EMAIL is not configured', async () => {
    const { handler, sent, logError } = setup({ BOOKING_EMAIL: '' });
    expect((await handler(event('POST', '/api/booking', good))).statusCode).toBe(500);
    expect(sent).toHaveLength(0);
    expect(logError).toHaveBeenCalledOnce();
  });
});

it('answers unknown routes with 404', async () => {
  const { handler } = setup();
  expect((await handler(event('GET', '/api/booking'))).statusCode).toBe(404);
});
