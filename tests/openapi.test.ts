import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createOpenApiDocument } from '../src/http/openapi.js';

describe('milestone 3 API contract', () => {
  it('keeps the committed OpenAPI document aligned with runtime Zod schemas', async () => {
    const artifact = JSON.parse(
      await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'),
    );
    expect(artifact).toEqual(createOpenApiDocument());
    expect(artifact.openapi).toBe('3.1.0');
    expect(Object.keys(artifact.paths)).toHaveLength(21);
  });
});
