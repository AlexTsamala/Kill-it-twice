import { z } from 'zod';

export type ErrorClass = 'transient' | 'permanent';

const TOO_MANY_REQUESTS = 429;
const FIRST_SERVER_ERROR = 500;

const TRANSIENT_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const TRANSIENT_ERROR_NAMES = new Set([
  'ConnectionError',
  'TimeoutError',
  'NoLivingConnectionsError',
]);

const statusCarrierSchema = z.object({ statusCode: z.number().int() });
const codeCarrierSchema = z.object({ code: z.string() });

export function classifyResponseStatus(status: number): ErrorClass {
  if (status === TOO_MANY_REQUESTS) {
    return 'transient';
  }
  if (status >= FIRST_SERVER_ERROR) {
    return 'transient';
  }
  return 'permanent';
}

export function classifyThrownError(error: unknown): ErrorClass {
  if (!(error instanceof Error)) {
    return 'permanent';
  }

  const withStatus = statusCarrierSchema.safeParse(error);
  if (withStatus.success) {
    return classifyResponseStatus(withStatus.data.statusCode);
  }

  if (TRANSIENT_ERROR_NAMES.has(error.name)) {
    return 'transient';
  }

  const withCode = codeCarrierSchema.safeParse(error);
  if (withCode.success && TRANSIENT_SYSTEM_CODES.has(withCode.data.code)) {
    return 'transient';
  }

  return 'permanent';
}
