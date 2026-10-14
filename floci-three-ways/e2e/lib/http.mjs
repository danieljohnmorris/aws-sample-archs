// Small JSON client. Returns the status, headers and parsed body rather than
// throwing on a non-2xx, because the scenario asserts on 401 and 403.

export async function call(baseUrl, path, options = {}) {
  const url = `${String(baseUrl).replace(/\/$/, '')}${path}`;
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  let body;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers['content-type'] = headers['content-type'] || 'application/json';
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs || 15000),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: response.status, headers: response.headers, body: parsed, url };
}

export const get = (baseUrl, path, options) => call(baseUrl, path, { ...options, method: 'GET' });
export const post = (baseUrl, path, options) => call(baseUrl, path, { ...options, method: 'POST' });
