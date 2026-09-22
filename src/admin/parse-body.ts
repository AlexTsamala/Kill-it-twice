import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

export function parseBody<Parsed>(schema: ZodType<Parsed>, body: unknown): Parsed {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  return parsed.data;
}
