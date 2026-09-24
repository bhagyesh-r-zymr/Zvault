import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/** Validates and parses a request part with a shared zod contract. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        issues: z.prettifyError(result.error),
      });
    }
    return result.data;
  }
}
