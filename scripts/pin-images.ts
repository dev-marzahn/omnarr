// Pins the project's three images in compose.yml, for the
// release workflow's "Pin" step. Each `image:` of omnarr-backend,
// omnarr-worker and omnarr-web becomes `<name>:<version>@<digest>`; every
// other line, comments included, is kept as it is.
//
//   node scripts/pin-images.ts --version 0.1.0-p1 --digests digests.json
//
// digests.json: { "omnarr-backend": "sha256:…", "omnarr-worker": "sha256:…", "omnarr-web": "sha256:…" }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parseCompose } from './check-ports.ts';

export const PROJECT_IMAGES = ['omnarr-backend', 'omnarr-worker', 'omnarr-web'] as const;
const REGISTRY = 'ghcr.io/dev-marzahn';

export function pinImages(compose: string, version: string, digests: Record<string, string>): string {
  for (const name of Object.keys(digests)) if (!(PROJECT_IMAGES as readonly string[]).includes(name)) throw new Error(`unknown image ${name}`);
  let out = compose;
  for (const name of PROJECT_IMAGES) {
    const digest = digests[name];
    if (!digest) throw new Error(`no digest for ${name}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${name}: ${digest} is not a sha256 digest`);
    const line = new RegExp(`(image:\\s*['"]?)${REGISTRY.replaceAll('.', '\\.')}/${name}(?::[^@\\s'"]+)?(?:@sha256:[0-9a-f]{64})?`, 'g');
    if (!line.test(out)) throw new Error(`compose.yml has no ${name} image`);
    out = out.replace(line, `$1${REGISTRY}/${name}:${version}@${digest}`);
  }
  // The result still parses, and pins what it was asked to.
  const services = (parseCompose(out) as { services: Record<string, { image?: string }> }).services;
  for (const name of PROJECT_IMAGES)
    if (!Object.values(services).some((service) => service.image === `${REGISTRY}/${name}:${version}@${digests[name]}`))
      throw new Error(`${name} wasn't pinned`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { version: { type: 'string' }, digests: { type: 'string' } } });
  if (!values.version || !values.digests) {
    console.error('Usage: node scripts/pin-images.ts --version <v> --digests <file>');
    process.exit(2);
  }
  const file = join(fileURLToPath(import.meta.url), '../../compose.yml');
  writeFileSync(file, pinImages(readFileSync(file, 'utf8'), values.version, JSON.parse(readFileSync(values.digests, 'utf8')) as Record<string, string>));
  console.log(`Pinned ${PROJECT_IMAGES.join(', ')} at ${values.version}.`);
}
