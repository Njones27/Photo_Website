import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/** Every response is JSON and never cached: CloudFront must not keep any of them. */
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;

export interface Reply extends APIGatewayProxyStructuredResultV2 {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const json = (statusCode: number, body: unknown): Reply => ({
  statusCode,
  headers: { ...HEADERS },
  body: JSON.stringify(body),
});

export type ErrorCode = 'bad_request' | 'forbidden' | 'not_found' | 'payload_too_large' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  payload_too_large: 413,
  internal: 500,
};

/** What a visitor may see. Each line has to make sense shown on its own under the booking form. */
export const MESSAGES = {
  badRequest: "That request couldn't be read. Please try again.",
  forbidden: 'Please send your request from nathanjonesphoto.co.',
  notFound: 'Not found.',
  tooLarge: 'That message is too long. Please shorten it and try again.',
  internal: "Your request didn't go through. Please try again in a minute.",
} as const;

export const fail = (code: ErrorCode, message: string, field?: string): Reply =>
  json(STATUS[code], field ? { error: code, message, field } : { error: code, message });

/** Lambda environment, set by infra/stack/api-stack.ts. */
export interface Env {
  STAGE?: string;
  APP_VERSION?: string;
  ORIGIN_VERIFY_SECRET?: string;
  /** The AWS account's own email: booking requests are sent from and to it. */
  BOOKING_EMAIL?: string;
}

/** Sends one email. The real one wraps SES; tests pass a fake. */
export interface Mailer {
  send(message: { from: string; to: string; replyTo: string; subject: string; text: string }): Promise<void>;
}

/** What a route gets: the parsed JSON body (undefined when there was none), lower-cased headers, and its tools. */
export interface ApiRequest {
  body: unknown;
  headers: Readonly<Record<string, string>>;
  now: Date;
  env: Env;
  mailer: () => Mailer;
  /** One JSON log line at info or warn level. Errors go through the handler's catch, which the alarm counts. */
  log: (level: 'info' | 'warn', message: string, detail?: Record<string, unknown>) => void;
}
