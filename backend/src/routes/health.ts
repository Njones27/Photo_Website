import { json, type ApiRequest, type Reply } from '../lib/http';

/** `GET /api/health`: used by the deploy smoke test through CloudFront. Sends nothing. */
export const health = ({ env, now }: ApiRequest): Reply =>
  json(200, { ok: true, stage: env.STAGE || 'local', version: env.APP_VERSION || 'local', time: now.toISOString() });
