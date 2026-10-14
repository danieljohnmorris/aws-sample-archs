// Loads infra/<arch>/.env and infra/<arch>/outputs.json, and decides whether a
// suite can run at all.
import { readFile } from 'node:fs/promises';

export const ARCH = process.env.ARCH || 'local';

const REPO_ROOT = new URL('../../', import.meta.url);

/** Reads KEY=VALUE lines into process.env. An existing value is left alone. */
export async function loadArchEnv(arch) {
  const path = new URL(`infra/${arch}/.env`, REPO_ROOT);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const loaded = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split < 1) continue;
    const key = trimmed.slice(0, split).trim();
    const value = trimmed.slice(split + 1).trim().replace(/^["']|["']$/g, '');
    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  // The SDK v3 environment provider reads AWS_REGION, not AWS_DEFAULT_REGION.
  if (!process.env.AWS_REGION && process.env.AWS_DEFAULT_REGION) {
    process.env.AWS_REGION = process.env.AWS_DEFAULT_REGION;
  }
  return loaded;
}

/** Flattens `cdk deploy --outputs-file`, which is keyed by stack name. */
export async function readOutputs(arch) {
  const path = new URL(`infra/${arch}/outputs.json`, REPO_ROOT);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const flat = {};
  for (const outputs of Object.values(JSON.parse(text))) {
    for (const [key, value] of Object.entries(outputs || {})) flat[key] = value;
  }
  return flat;
}

/**
 * Prepares a suite for one architecture. Returns a skip reason when ARCH names
 * a different architecture or the stacks have not been deployed, so
 * `make conformance` never fails for want of a file.
 */
export async function archHarness(arch) {
  if (ARCH !== arch) return { skip: `ARCH is ${ARCH}, so the ${arch} suite does not apply`, outputs: null };
  await loadArchEnv(arch);
  const outputs = await readOutputs(arch);
  if (!outputs) {
    return {
      skip: `infra/${arch}/outputs.json is missing. Run make deploy ARCH=${arch}`,
      outputs: null,
    };
  }
  return { skip: false, outputs, clientConfig: clientConfig() };
}

function clientConfig() {
  const config = {};
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (region) config.region = region;
  if (process.env.AWS_ENDPOINT_URL) config.endpoint = process.env.AWS_ENDPOINT_URL;
  return config;
}

/** Reads a required output and names the key that is missing. */
export function requireOutput(outputs, key, arch = ARCH) {
  const value = outputs?.[key];
  if (!value) throw new Error(`infra/${arch}/outputs.json has no ${key}`);
  return value;
}
