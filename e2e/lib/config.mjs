// Where the scenario points: in-process servers for ARCH=local, CloudFormation
// outputs for ARCH=a, b or c.
import { readFile } from 'node:fs/promises';

export const ARCH = process.env.ARCH || 'local';
export const IS_LOCAL = ARCH === 'local';

const REPO_ROOT = new URL('../../', import.meta.url);

/**
 * Loads infra/<arch>/.env into process.env. Anything already set in the
 * environment wins, so `make` and a shell export both work.
 */
export async function loadArchEnv(arch = ARCH) {
  if (arch === 'local') return {};
  const path = new URL(`infra/${arch}/.env`, REPO_ROOT);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`missing ${path.pathname}. Run make up ARCH=${arch} first`);
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

/**
 * Flattens `cdk deploy --outputs-file` into one key to value map. The file is
 * keyed by stack name, and no two stacks in an architecture share an output key.
 */
export async function readOutputs(arch = ARCH) {
  const path = new URL(`infra/${arch}/outputs.json`, REPO_ROOT);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const byStack = JSON.parse(text);
  const flat = {};
  for (const outputs of Object.values(byStack)) {
    for (const [key, value] of Object.entries(outputs || {})) flat[key] = value;
  }
  return flat;
}

/** Reads a required output and says which stack should have produced it. */
export function requireOutput(outputs, key) {
  const value = outputs?.[key];
  if (!value) throw new Error(`outputs.json has no ${key}. Run make deploy ARCH=${ARCH}`);
  return value;
}

export function region() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
}
