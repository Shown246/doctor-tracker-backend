import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createOpenApiDocument } from '../http/openapi.js';

const output = new URL('../../docs/openapi.json', import.meta.url);
const config = await resolveConfig(fileURLToPath(output));
await writeFile(
  output,
  await format(JSON.stringify(createOpenApiDocument()), {
    ...config,
    parser: 'json',
  }),
);
console.log('Wrote docs/openapi.json from runtime schemas');
