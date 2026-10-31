import { writeFile } from 'node:fs/promises';
import { createOpenApiDocument } from '../http/openapi.js';

await writeFile(
  new URL('../../docs/openapi.json', import.meta.url),
  `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`,
);
console.log('Wrote docs/openapi.json from runtime schemas');
