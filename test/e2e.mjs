#!/usr/bin/env node
/** CLI 端到端：两段审批登录（脚本代批注册 + 代确认设备）→ 出图落盘校验 → whoami/stats/jobs →
 * 吊销 → 401 → 同一台机器再登录免注册审批 → 收尾忘掉这台机器的注册记录。
 *
 * 用法: node test/e2e.mjs [--base http://127.0.0.1:8189] [--token 共享token]
 *                        [--steps 12] [--keep]
 *
 * 共享 token 取 --token、COMFYUI_API_TOKEN，或仓库根 .env（已在 .gitignore）。
 * 会生成真图（约 20s/张），结束时删掉临时凭据与图片，并删掉服务端这台临时机器的
 * 注册记录（--keep 只保留本地目录，注册记录照删）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'comfyui.js');
const ENV_FILE = path.join(HERE, '..', '.env');

function parseArgs(argv) {
  const opts = { base: 'http://127.0.0.1:8189', token: '', steps: 12, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (key === '--base') opts.base = value;
    else if (key === '--token') opts.token = value;
    else if (key === '--steps') opts.steps = Number(value);
    else if (key === '--keep') opts.keep = true;
    else throw new Error(`未知参数 ${argv[i]}`);
    if (inline === undefined && key !== '--keep') i += 1;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const BASE = opts.base.replace(/\/+$/, '');

function sharedToken() {
  if (opts.token) return opts.token;
  if (process.env.COMFYUI_API_TOKEN) return process.env.COMFYUI_API_TOKEN;
  if (fs.existsSync(ENV_FILE)) {
    const line = fs.readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('COMFYUI_API_TOKEN='));
    if (line) return line.split('=')[1].trim();
  }
  throw new Error('缺少共享 token：用 --token 传入，或设置 COMFYUI_API_TOKEN / 仓库根 .env');
}

const TOKEN = sharedToken();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-e2e-'));
const cfgDir = path.join(workDir, 'cfg');
const outDir = path.join(workDir, 'out');
const env = { ...process.env, COMFYUI_CLI_CONFIG_DIR: cfgDir };
delete env.COMFYUI_CLI_TOKEN;
delete env.COMFYUI_API_TOKEN;
delete env.COMFYUI_CLI_URL;

let step = 0;
const pass = (msg, extra = '') => console.log(`  [✓] ${msg}${extra ? `  — ${extra}` : ''}`);
const title = (msg) => console.log(`\n${msg}`);
const ok = (cond, msg, extra) => {
  step += 1;
  assert.ok(cond, msg);
  pass(msg, extra);
};

/** 跑 CLI，返回 {code, stdout, stderr}（不抛错，便于断言非零退出码） */
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/** 登录：起子进程等设备码，脚本按两段审批代批，再等它换到 token */
async function loginThroughBrowser(label) {
  const child = spawn(
    process.execPath,
    [CLI, 'login', '--url', BASE, '--label', label, '--no-browser'],
    { env },
  );
  let output = '';
  let done;
  const finished = new Promise((resolve) => {
    done = resolve;
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    const m = /设备码: ([A-Z0-9-]+)/.exec(output);
    if (m) {
      output = output.replace(/设备码: [A-Z0-9-]+/, '设备码: <已用>'); // 只批一次
      approveTwoStages(m[1]).catch((e) => {
        output += `\n审批失败: ${e.message}`;
      });
    }
  });
  child.stderr.on('data', (c) => {
    output += c;
  });
  child.on('close', (code) => done({ code, output }));
  const result = await Promise.race([
    finished,
    new Promise((r) => setTimeout(() => r({ code: null, output: `${output}\n（超时未结束）` }), 120_000)),
  ]);
  if (result.code === null) child.kill('SIGKILL');
  return result;
}

/** 两段审批：先拿 access code 批注册（303 跳设备授权页），再以发起人身份确认设备码 */
async function approveTwoStages(userCode) {
  const reg = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: userCode, token: TOKEN, action: 'approve' }),
    redirect: 'manual',
  });
  if (reg.status !== 303) {
    throw new Error(`注册审批 HTTP ${reg.status}: ${(await reg.text()).slice(0, 200)}`);
  }
  const location = reg.headers.get('location') || '';
  if (!location.includes(`/oauth/device?user_code=${userCode}`)) {
    throw new Error(`注册审批没跳到设备页: ${location}`);
  }
  const dev = await fetch(`${BASE}/oauth/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: userCode, action: 'approve' }),
  });
  const text = await dev.text();
  if (dev.status !== 200) throw new Error(`设备授权 HTTP ${dev.status}: ${text.slice(0, 200)}`);
  if (!/已授权/.test(text)) throw new Error(`设备授权没批准成功: ${text.slice(0, 300)}`);
  return true;
}

/** 忘掉这台机器（管理端等价于 `invoke clients --action forget`）；返回 HTTP 状态码 */
async function forgetMachine(id) {
  const res = await fetch(`${BASE}/v1/clients/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return res.status;
}

async function clientRegistered(id) {
  const res = await fetch(`${BASE}/v1/clients`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const data = await res.json();
  return (data.clients || []).some((c) => c.client_id === id);
}

/** 解析 PNG 并检查不是黑图/纯色（与 api/smoke_test.mjs 同一套判据） */
function checkPng(fileOrBuf) {
  const buf = Buffer.isBuffer(fileOrBuf) ? fileOrBuf : fs.readFileSync(fileOrBuf);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名不对');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  assert.equal(bitDepth, 8, '只支持 8 位 PNG');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(channels, `不支持的 colorType ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  const seen = new Set();
  let min = 255;
  let max = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < stride; x += 16) {
      seen.add(line[x]);
      if (line[x] < min) min = line[x];
      if (line[x] > max) max = line[x];
    }
  }
  return { width, height, unique: seen.size, min, max };
}

const results = [];
try {
  title(`[1] 两段审批登录（base=${BASE}）`);
  const login = await loginThroughBrowser('e2e');
  ok(login.code === 0, 'comfyui login 走完两段审批', `exit=${login.code}`);
  ok(/还没登记，先让持有 access code 的人批准注册/.test(login.output), '新机器先要注册审批');
  ok(/已登录/.test(login.output), '打印登录结果');

  const authPath = path.join(cfgDir, 'auth.json');
  ok(fs.existsSync(authPath), '凭据写入用户目录', authPath.replace(os.tmpdir(), '$TMPDIR'));
  ok((fs.statSync(authPath).mode & 0o777) === 0o600, '凭据文件权限 600');
  const cred = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const url = Object.keys(cred.servers)[0];
  const stored = cred.servers[url];
  ok(stored.access_token?.startsWith('comfyui_'), '落盘的是设备 token', `${stored.token_id} label=${stored.label}`);
  ok(cred.default === BASE, '该地址成为默认服务');

  title('[2] 只读命令');
  const who = await cli(['whoami', '--json']);
  const me = JSON.parse(who.stdout);
  ok(who.code === 0 && me.kind === 'token' && me.token_id === stored.token_id, 'whoami 认出这枚 token');
  const tpl = await cli(['templates', '--json']);
  const templates = JSON.parse(tpl.stdout);
  ok(tpl.code === 0 && templates.length > 0, 'templates 列出内置模板', templates.join(', '));

  title('[3] 出图（CLI 按 class_type 定位节点）');
  const gen = await cli([
    'generate',
    '-t',
    templates[0],
    '--prompt',
    'a red apple on a wooden table, soft daylight',
    '--negative',
    'blurry, text',
    '--steps',
    String(opts.steps),
    '--size',
    '1024x1024',
    '--seed',
    '424242',
    '--out',
    outDir,
    '--json',
  ]);
  ok(gen.code === 0, 'generate 成功', gen.stderr.trim().split('\n').at(-1) || '');
  const result = JSON.parse(gen.stdout);
  ok(result.status === 'completed', '作业完成', `${result.elapsed_s}s`);
  ok(result.images.length === 1, '落盘 1 张图', result.images.map((i) => path.basename(i.path)).join(', '));
  const png = checkPng(result.images[0].path);
  ok(png.width === 1024 && png.height === 1024, '图片尺寸符合 --size', `${png.width}x${png.height}`);
  ok(png.unique > 16 && png.max - png.min > 32, '不是黑图/纯色', `唯一色=${png.unique} 极值=${png.min}..${png.max}`);

  title('[4] 分享链接（免鉴权下载）');
  const share = await cli(['share', result.job_id, '--ttl', '10m', '--json']);
  const link = JSON.parse(share.stdout);
  ok(share.code === 0 && link.expires_in === 600 && link.images.length === 1, 'share 签发限时链接', `${link.expires_in}s`);
  const pub = await fetch(link.images[0].url).catch((e) => ({ status: 0, statusText: e.message }));
  ok(pub.status === 200, '免鉴权按链接取图', `HTTP ${pub.status}`);
  const shared = checkPng(Buffer.from(await pub.arrayBuffer()));
  ok(shared.unique > 16 && shared.max - shared.min > 32, '分享图不是黑图/纯色', `唯一色=${shared.unique}`);
  const tampered = await fetch(link.images[0].url.replace(/sig=[^&]+/, 'sig=nope'));
  ok(tampered.status === 403, '改签名 → 403', `HTTP ${tampered.status}`);

  title('[5] 作业与概览');
  const jobs = await cli(['jobs', '--limit', '3', '--json']);
  const list = JSON.parse(jobs.stdout);
  ok(jobs.code === 0 && list.jobs.some((j) => j.job_id === result.job_id), 'jobs 列表里有刚才的作业');
  const one = await cli(['jobs', result.job_id]);
  ok(one.code === 0 && /completed/.test(one.stdout), 'jobs <id> 详情可读');
  const stats = await cli(['stats']);
  ok(stats.code === 0 && /排队:/.test(stats.stdout), 'stats 可读');

  title('[6] 退出与失效');
  const logout = await cli(['logout']);
  ok(logout.code === 0 && /已吊销/.test(logout.stdout), 'logout 吊销设备 token', logout.stdout.trim());
  const after = await cli(['whoami', '--url', BASE, '--token', stored.access_token]);
  ok(after.code === 1 && /401/.test(after.stderr), '被吊销的 token → 401');
  const again = await cli(['whoami']);
  ok(again.code === 2 && /comfyui login/.test(again.stderr), '本地凭据已清，提示重新登录');
  ok(!fs.existsSync(authPath) || Object.keys(JSON.parse(fs.readFileSync(authPath, 'utf8')).servers).length === 0, '凭据文件里已无该服务');

  title('[7] 记住批过的机器');
  const relogin = await loginThroughBrowser('e2e-again');
  ok(relogin.code === 0, '同一台机器再登录成功', `exit=${relogin.code}`);
  ok(/这台机器已经登记过，直接确认设备/.test(relogin.output), '跳过注册审批（服务端按机器指纹记住）');
  ok(
    /直达链接: \S*\/oauth\/device\?user_code=/.test(relogin.output) && !/\/oauth\/register\?user_code=/.test(relogin.output),
    '已注册机器直达设备授权页，不再给注册页',
    (relogin.output.match(/直达链接: \S+/) || [''])[0],
  );
  const reloginCred = JSON.parse(fs.readFileSync(authPath, 'utf8')).servers[BASE];
  ok(reloginCred.access_token?.startsWith('comfyui_'), '又换到一枚可用 token', reloginCred.token_id);
  const cleanup = await cli(['logout']);
  ok(cleanup.code === 0 && /已吊销/.test(cleanup.stdout), '收尾吊销第二枚 token');

  title('[8] 收尾：忘掉这台临时机器');
  const machineId = JSON.parse(fs.readFileSync(path.join(cfgDir, 'machine.json'), 'utf8')).id;
  ok((await forgetMachine(machineId)) === 200, '注册记录已删除（下次登录重走注册审批）', machineId.slice(0, 8));
  ok(!(await clientRegistered(machineId)), '服务端注册表里不再有这台机器');
} catch (err) {
  console.log(`\n失败：${err.message}`);
  if (process.env.COMFYUI_CLI_DEBUG) console.log(err.stack);
  process.exitCode = 1;
} finally {
  // 跑挂了也别把这台临时机器留在服务端；已删掉（404）算成功
  try {
    const machineFile = path.join(cfgDir, 'machine.json');
    if (fs.existsSync(machineFile)) await forgetMachine(JSON.parse(fs.readFileSync(machineFile, 'utf8')).id);
  } catch {
    /* 收尾尽力而为，不掩盖真正的失败 */
  }
  if (opts.keep) {
    console.log(`\n（--keep）临时目录保留在 ${workDir}`);
  } else {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (!process.exitCode) console.log(`\n全部通过 ✓  （${step} 项）`);
}
