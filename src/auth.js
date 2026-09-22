/** 凭据与设备码登录：token 存 ~/.config/comfyui/auth.json（0600），服务端只留 sha256。 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ApiError, createClient } from './api.js';

export const DEFAULT_URL = 'https://comfyui-api.weisanju.fun';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export function configDir() {
  return process.env.COMFYUI_CLI_CONFIG_DIR || path.join(os.homedir(), '.config', 'comfyui');
}

export function authFile() {
  return path.join(configDir(), 'auth.json');
}

export function machineFile() {
  return path.join(configDir(), 'machine.json');
}

/**
 * 机器指纹：随机生成一次、长期复用，服务端按它记住「这台机器批过注册审批」。
 * 换 hostname、换凭据都不影响；删了这个文件等于换了台机器，要重新审批。
 */
export function machineIdentity() {
  try {
    const data = JSON.parse(fs.readFileSync(machineFile(), 'utf8'));
    if (data?.id) {
      return { id: String(data.id), hostname: os.hostname(), platform: process.platform };
    }
  } catch {
    /* 没写过或写坏了，下面重新生成 */
  }
  const identity = {
    id: crypto.randomBytes(16).toString('hex'),
    hostname: os.hostname(),
    platform: process.platform,
    created_at: Date.now() / 1000,
  };
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(machineFile(), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(machineFile(), 0o600);
  return identity;
}

export function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    return { default: data.default ?? null, servers: data.servers ?? {} };
  } catch {
    return { default: null, servers: {} };
  }
}

function writeConfig(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = authFile();
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function saveCredential(url, cred, { makeDefault = true } = {}) {
  const cfg = loadConfig();
  const root = String(url).replace(/\/+$/, '');
  cfg.servers[root] = cred;
  if (makeDefault || !cfg.default) cfg.default = root;
  writeConfig(cfg);
}

export function removeCredential(url) {
  const cfg = loadConfig();
  const root = String(url).replace(/\/+$/, '');
  delete cfg.servers[root];
  if (cfg.default === root) cfg.default = Object.keys(cfg.servers)[0] ?? null;
  writeConfig(cfg);
  return cfg;
}

export function clearCredentials() {
  writeConfig({ default: null, servers: {} });
}

/** 解析目标地址：--url > COMFYUI_CLI_URL > 配置里的 default > 唯一一条记录 > 内置默认值。 */
export function resolveUrl(explicit) {
  const cfg = loadConfig();
  const candidates = [
    explicit,
    process.env.COMFYUI_CLI_URL,
    cfg.default,
    Object.keys(cfg.servers).length === 1 ? Object.keys(cfg.servers)[0] : null,
  ];
  const found = candidates.find((v) => typeof v === 'string' && v.trim());
  return (found || DEFAULT_URL).replace(/\/+$/, '');
}

/** 解析 token：COMFYUI_CLI_TOKEN > 该地址存下的凭据；返回来源，便于报错与 whoami。 */
export function resolveToken(url, store = loadConfig()) {
  if (process.env.COMFYUI_CLI_TOKEN?.trim()) {
    return { token: process.env.COMFYUI_CLI_TOKEN.trim(), source: 'env', cred: null };
  }
  const cred = store.servers[String(url).replace(/\/+$/, '')];
  if (!cred?.access_token) return { token: '', source: 'none', cred: null };
  return { token: cred.access_token, source: 'file', cred };
}

export function isExpired(cred) {
  return Boolean(cred?.expires_at) && cred.expires_at * 1000 <= Date.now();
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * RFC 8628 设备码登录：申请设备码 → 机器没在册就先让持 access code 的人批注册 →
 * 发起人自己在设备授权页确认 → 轮询换 token → 落盘。
 * 机器指纹随请求带上，服务端批过一次就一直记得，之后直接进设备授权那一段。
 */
export async function deviceLogin({ url, label, noBrowser = false, log = () => {} }) {
  const root = String(url).replace(/\/+$/, '');
  const client = createClient({ baseUrl: root });
  const me = machineIdentity();
  const requestCode = () =>
    client.post('/oauth/device/code', {
      body: { client_id: me.id, hostname: me.hostname, platform: me.platform, label },
    });

  let code;
  try {
    code = await requestCode();
  } catch (err) {
    // 申请设备码是免鉴权端点，服务端按 IP 限流；撞上了就等它说的秒数再试一次
    if (!(err instanceof ApiError) || err.status !== 429) throw err;
    const wait = Math.max(1, Number(err.headers?.get?.('retry-after')) || 10);
    log(`申请太频繁，${wait} 秒后重试…`);
    await sleep(wait * 1000);
    code = await requestCode();
  }

  log('');
  if (code.registration_required) {
    log('这台机器还没登记，先让持有 access code 的人批准注册（批一次就够，之后不再需要）');
    log(`  注册审批页: ${code.registration_uri}`);
  } else {
    log('这台机器已经登记过，直接确认设备即可');
  }
  log(`  设备码: ${code.user_code}`);
  log(`  直达链接: ${code.verification_uri_complete}`);
  log('');
  if (noBrowser) {
    log('（--no-browser：请手动打开上面的链接）');
  } else if (!openBrowser(code.verification_uri_complete)) {
    log('（打不开浏览器，请手动打开上面的链接）');
  }

  const intervalMs = Math.max(1, code.interval || 5) * 1000;
  const deadline = Date.now() + (code.expires_in || 600) * 1000;
  let slowDown = 0;
  let waitingRegistration = false;
  while (Date.now() < deadline) {
    await sleep(intervalMs + slowDown * 1000);
    let data;
    try {
      data = await client.post('/oauth/token', {
        form: { grant_type: DEVICE_GRANT, device_code: code.device_code },
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'registration_pending') {
        if (!waitingRegistration) {
          waitingRegistration = true;
          log(`等待注册审批…（${code.user_code}）`);
          log(`  注册审批页: ${code.registration_uri}`);
        }
        continue;
      }
      if (err.code === 'authorization_pending') {
        if (waitingRegistration) {
          waitingRegistration = false;
          log('注册已通过，请在浏览器里确认这次登录…');
        } else {
          log(`等待授权…（${code.user_code}，Ctrl-C 取消）`);
        }
        continue;
      }
      if (err.code === 'slow_down') {
        slowDown += 1;
        continue;
      }
      if (err.code === 'access_denied') throw new ApiError(403, '授权被拒绝（access_denied）');
      if (err.code === 'expired_token') throw new ApiError(408, '设备码已过期，请重新登录');
      throw err;
    }
    const now = Date.now() / 1000;
    const cred = {
      access_token: data.access_token,
      token_id: data.token_id,
      label: data.label,
      scope: data.scope,
      created_at: now,
      expires_at: data.expires_in ? now + data.expires_in : null,
    };
    saveCredential(root, cred);
    return { url: root, ...cred };
  }
  throw new ApiError(408, '设备码已过期，请重新登录');
}
