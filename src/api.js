/** HTTP 客户端：错误统一成 ApiError，便于上层决定退出码与提示。 */

export class ApiError extends Error {
  constructor(status, detail, { code = null, headers = null, url = '' } = {}) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.headers = headers;
    this.url = url;
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function networkDetail(err, url) {
  const cause = err?.cause?.code || err?.code || '';
  if (cause === 'ECONNREFUSED') return `连接被拒绝：${url}（服务没起或端口不对）`;
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') return `域名解析失败：${url}`;
  if (cause === 'CERT_HAS_EXPIRED' || cause === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `TLS 证书校验失败：${url}（${cause}）`;
  }
  if (err?.name === 'TimeoutError' || cause === 'UND_ERR_CONNECT_TIMEOUT') {
    return `请求超时：${url}`;
  }
  if (/bad port/i.test(err?.cause?.message || '')) return `端口非法：${url}`;
  return `请求失败：${url}（${err?.cause?.message || err?.message || err}）`;
}

export function createClient({ baseUrl, token = '', timeoutMs = 60_000 }) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function send(path, { method = 'GET', body, form, raw, contentType, timeoutMs: t } = {}) {
    const url = `${root}${path}`;
    const headers = { accept: 'application/json, */*' };
    let payload;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (raw !== undefined) {
      headers['content-type'] = contentType || 'application/octet-stream';
      payload = raw;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (token) headers.authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(t ?? timeoutMs),
      });
    } catch (err) {
      throw new ApiError(0, networkDetail(err, url), { url });
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const detail =
        data?.detail ??
        data?.error_description ??
        data?.error ??
        (text ? text.slice(0, 300) : `HTTP ${res.status}`);
      throw new ApiError(res.status, detail, {
        code: data?.error ?? null,
        headers: res.headers,
        url,
      });
    }
    return data;
  }

  async function download(path, { timeoutMs: t } = {}) {
    const url = `${root}${path}`;
    let res;
    try {
      res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(t ?? 120_000),
      });
    } catch (err) {
      throw new ApiError(0, networkDetail(err, url), { url });
    }
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        detail = JSON.parse(text).detail ?? detail;
      } catch {
        /* 保持原始文本 */
      }
      throw new ApiError(res.status, detail || `HTTP ${res.status}`, { url });
    }
    return {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      filename: (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1],
    };
  }

  return {
    baseUrl: root,
    token,
    send,
    download,
    get: (path, opts) => send(path, { ...opts, method: 'GET' }),
    post: (path, opts) => send(path, { ...opts, method: 'POST' }),
    del: (path, opts) => send(path, { ...opts, method: 'DELETE' }),
    // 裸字节上传：Content-Type 走头，不套 multipart
    upload: (path, bytes, contentType, opts) =>
      send(path, { ...opts, method: 'POST', raw: bytes, contentType, timeoutMs: opts?.timeoutMs ?? 120_000 }),
  };
}
