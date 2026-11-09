import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { MIN_SECRET_LENGTH, secretsEqual } from './lib/auth';
import { fail, MESSAGES, type ApiRequest, type Env, type Mailer, type Reply } from './lib/http';
import { SesMailer } from './lib/mailer';
import { createBooking } from './routes/booking';
import { health } from './routes/health';

// One Lambda behind API Gateway (HTTP API, payload 2.0) behind CloudFront `/api/*`.

export const MAX_BODY_BYTES = 16 * 1024;

interface Route {
  method: string;
  path: RegExp;
  run: (req: ApiRequest) => Reply | Promise<Reply>;
}

const ROUTES: readonly Route[] = [
  { method: 'GET', path: /^\/api\/health$/, run: health },
  { method: 'POST', path: /^\/api\/booking$/, run: createBooking },
];

export interface Deps {
  /** Defaults to `process.env`. */
  env?: Env;
  /** Defaults to SES, built on first use and kept for the container's life. */
  mailer?: Mailer;
  now?: () => Date;
  /** Where unexpected errors go. Defaults to one JSON line on stderr (CloudWatch Logs). */
  logError?: (message: string, detail: Record<string, unknown>) => void;
}

export type Handler = (event: APIGatewayProxyEventV2) => Promise<Reply>;

const defaultLogError: NonNullable<Deps['logError']> = (message, detail) =>
  // Lambda's JSON log format nests this object under the record, so the Ops metric filter can match on level.
  console.error({ level: 'error', message, ...detail });

const lowerCaseKeys = (headers: APIGatewayProxyEventV2['headers'] | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => [name.toLowerCase(), value]),
  );

/** The request body as text, `null` when it is over the size cap, or undefined when there is none. */
function bodyText(event: APIGatewayProxyEventV2): string | null | undefined {
  const raw = event.body;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw.length > (event.isBase64Encoded ? Math.ceil((MAX_BODY_BYTES * 4) / 3) + 4 : MAX_BODY_BYTES)) return null;
  const bytes = Buffer.from(raw, event.isBase64Encoded ? 'base64' : 'utf8');
  return bytes.length > MAX_BODY_BYTES ? null : bytes.toString('utf8');
}

export function createHandler(deps: Deps = {}): Handler {
  const env: Env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const logError = deps.logError ?? defaultLogError;
  let mailer = deps.mailer;
  const getMailer = (): Mailer => (mailer ??= new SesMailer());

  return async (event) => {
    const method = event.requestContext?.http?.method?.toUpperCase() ?? '';
    const path = event.rawPath ?? '';
    try {
      const headers = lowerCaseKeys(event.headers);
      // Fails closed: without a proper secret nothing is served, so a broken deploy can't open the API to the world.
      const secret = env.ORIGIN_VERIFY_SECRET ?? '';
      if (secret.length < MIN_SECRET_LENGTH) {
        logError('ORIGIN_VERIFY_SECRET is missing or too short, so every request is refused', {
          route: `${method} ${path}`,
          requestId: event.requestContext?.requestId,
        });
        return fail('forbidden', MESSAGES.forbidden);
      }
      if (!secretsEqual(headers['x-origin-verify'] ?? '', secret)) return fail('forbidden', MESSAGES.forbidden);

      const text = bodyText(event);
      if (text === null) return fail('payload_too_large', MESSAGES.tooLarge);
      let body: unknown;
      if (text !== undefined && text.trim() !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          return fail('bad_request', MESSAGES.badRequest);
        }
      }

      for (const route of ROUTES) {
        if (route.method !== method || !route.path.test(path)) continue;
        return await route.run({ body, headers, now: now(), env, mailer: getMailer });
      }
      return fail('not_found', MESSAGES.notFound);
    } catch (err) {
      // Details stay in the log. The visitor only ever sees the friendly message.
      logError('Unhandled error', {
        route: `${method} ${path}`,
        requestId: event.requestContext?.requestId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      return fail('internal', MESSAGES.internal);
    }
  };
}

export const handler: APIGatewayProxyHandlerV2 = createHandler();
