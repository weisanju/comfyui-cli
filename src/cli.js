/** comfyui 命令行入口：子命令解析、输出与退出码（0 成功 / 1 运行错误 / 2 用法错误 / 3 作业失败）。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ApiError, UsageError, createClient } from './api.js';
import {
  DEFAULT_URL,
  authFile,
  clearCredentials,
  configDir,
  deviceLogin,
  isExpired,
  loadConfig,
  machineFile,
  machineIdentity,
  removeCredential,
  resolveToken,
  resolveUrl,
  saveCredential,
} from './auth.js';
import {
  PKG_NAME,
  compareVersions,
  installCommand,
  installKind,
  latestVersion,
  registryUrl,
  runInstall,
} from './update.js';
import {
  applyOverrides,
  assertApiFormat,
  buildOverrides,
  outputName,
  parseGraph,
  randomSeed,
} from './workflow.js';

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, JOB_FAILED: 3 };
const POLL_MS = 2000;
const WAIT_LIMIT_MS = 3 * 3600 * 1000;

const out = (text = '') => process.stdout.write(`${text}\n`);
const err = (text = '') => process.stderr.write(`${text}\n`);

function version() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

function fmtTime(seconds) {
  if (!seconds) return '永不过期';
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const HELP = `comfyui — ComfyUI 远程出图 CLI

用法: comfyui <命令> [选项]

登录与凭据
  login [--label 名称] [--no-browser]  OAuth 设备码登录：没登记过的机器先过注册审批，token 存本机
      --token <共享token>              直接用共享 token 当凭据（跳过设备码流程，兼容老脚本）
  logout [--all]            吊销当前 token 并删除本地凭据；--all 吊销该服务全部 token
  whoami                    当前凭据是谁（kind=shared|token、label、有效期）
  config [--show]           显示服务地址、凭据文件、机器指纹与登录状态

任务
  generate                  提交工作流出图（见下）
  jobs [ID] [--limit N]     列出最近作业；给 ID 看详情；--cancel 取消
  stats                     队列与耗时概览
  templates                 列出服务器内置模板

其它
  skill [-o 文件]           取服务端 /SKILL.md 调用说明
  update [--check] [--force]  把自己更新到 npm 最新版（--check 只看版本）
  help | --version

generate 选项
  -w, --workflow <文件>     API 格式工作流 JSON（ComfyUI 里「导出（API格式）」）
  -t, --template <名称>     改用服务端内置模板
      --prompt <文本>       正面提示词       --negative <文本>   负面提示词
      --steps <N>           采样步数         --cfg <N>           CFG
      --size <宽x高>        如 1024x1024     --seed <N>          随机种子（random 或负数 = 随机）
      --set <节点id.输入=值> 直接改任意节点输入，可重复
      --out <目录|文件>     图片保存位置（默认 ./comfyui-out/）
      --no-wait             提交后立即返回，不等待出图
      --json                机器可读输出

通用选项: --url <地址>  --token <token>  --help
环境变量: COMFYUI_CLI_URL  COMFYUI_CLI_TOKEN  COMFYUI_CLI_CONFIG_DIR

登录流程（两段审批）
  login 会打印一个链接：没登记过的机器先落到 /oauth/register，由持有 access code
  （共享 token）的人批一次，批完自动跳到 /oauth/device，发起人自己确认即可。
  机器指纹写在 ~/.config/comfyui/machine.json，批过一次就一直有效——下次登录直接确认设备。

示例
  comfyui login --label 我的笔记本
  comfyui generate -t qwen-image-2.1-t2i-gguf-api --prompt "雪山下的木屋，清晨薄雾"
  comfyui generate -w my.json --set 6.denoise=0.5 --out ./out/
  comfyui jobs --limit 5   /   comfyui jobs 3f2a… --cancel
`;

const BASE = {
  url: { type: 'string' },
  token: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/** parseArgs 只认 --opt=value，`--seed -1` 会被当成选项名；先把这种写法归一化。 */
function normalizeNegative(argv, extra) {
  const takesValue = new Set(
    Object.entries({ ...BASE, ...extra })
      .filter(([, spec]) => spec.type === 'string')
      .flatMap(([name, spec]) => [name, ...(spec.short ? [spec.short] : [])]),
  );
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const name = arg.startsWith('--') ? arg.slice(2) : arg.startsWith('-') ? arg.slice(1) : null;
    if (name && takesValue.has(name) && next !== undefined && /^-\d/.test(next)) {
      out.push(`${arg}=${next}`);
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function parse(argv, extra = {}) {
  // allowNegative 会把 --no-wait 吃成 wait=false，让这些开关静默失效，所以关掉它：
  // --no-wait / --no-browser 就是普通布尔选项名
  const { values, positionals } = parseArgs({
    args: normalizeNegative(argv, extra),
    options: { ...BASE, ...extra },
    allowPositionals: true,
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value.type === 'string' && value.multiple !== true && values[key] === '') {
      throw new UsageError(`--${key} 需要值`);
    }
  }
  return { values, positionals };
}

/** 解析地址 + token，缺 token 时直接给出「怎么登录」的提示。 */
function context(values) {
  const url = resolveUrl(values.url);
  const { token, source, cred } = resolveToken(url);
  const finalToken = values.token?.trim() || token;
  if (!finalToken) {
    throw new UsageError(`还没有 ${url} 的凭据。先执行：comfyui login --url ${url}`);
  }
  if (!values.token && source === 'file' && isExpired(cred)) {
    throw new ApiError(401, `本地凭据已过期（${fmtTime(cred.expires_at)}）：请重新 comfyui login`);
  }
  return {
    url,
    token: finalToken,
    source: values.token ? 'flag' : source,
    client: createClient({ baseUrl: url, token: finalToken }),
  };
}

function describeJob(job, { verbose = true } = {}) {
  const parts = [`状态: ${job.status}`];
  if (job.comfyui_status) parts.push(`上游: ${job.comfyui_status}`);
  if (job.queue_position) parts.push(`队列位置: ${job.queue_position}`);
  parts.push(`耗时: ${fmtDuration(job.elapsed_s)}`);
  if (job.source) parts.push(`来源: ${job.source}`);
  const lines = [parts.join('  ')];
  if (job.error) lines.push(`错误: ${job.error}`);
  if (verbose && job.images?.length) {
    lines.push(`图片: ${job.images.length} 张`);
    for (const img of job.images) lines.push(`  [${img.index}] ${img.filename} (${img.type})`);
  }
  return lines.join('\n');
}

function printJobsTable(jobs) {
  if (!jobs.length) {
    out('（没有作业）');
    return;
  }
  const rows = jobs.map((j) => [
    j.job_id.slice(0, 8),
    j.status,
    j.source || '-',
    fmtDuration(j.elapsed_s),
    j.images?.length ? `${j.images.length} 张` : '',
  ]);
  const head = ['JOB', '状态', '来源', '耗时', '图片'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  out(line(head));
  for (const row of rows) out(line(row));
}

async function waitForJob(client, jobId, { quiet = false } = {}) {
  const started = Date.now();
  let last = null;
  let ticker = null;
  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };
  const onSigint = () => {
    stopTicker();
    err('');
    err(`已中断等待；作业 ${jobId} 仍在服务端执行，可用 comfyui jobs ${jobId} 查看`);
    process.exit(130);
  };
  process.once('SIGINT', onSigint);
  try {
    while (Date.now() - started < WAIT_LIMIT_MS) {
      const job = await client.get(`/v1/jobs/${jobId}`);
      const key = `${job.status}/${job.comfyui_status}`;
      if (key !== last) {
        last = key;
        stopTicker();
        if (!quiet) {
          const line =
            job.status === 'queued'
              ? `排队中（第 ${job.queue_position ?? '?'} 位）`
              : job.status === 'running'
                ? '生成中…'
                : `状态: ${job.status}`;
          err(line);
          if (job.status === 'running') {
            ticker = setInterval(() => err(`生成中… ${fmtDuration((Date.now() - started) / 1000)}`), 30_000);
            ticker.unref?.();
          }
        }
      }
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new ApiError(504, `等待超时（>${fmtDuration(WAIT_LIMIT_MS / 1000)}），作业 ${jobId} 仍在服务端`);
  } finally {
    stopTicker();
    process.removeListener('SIGINT', onSigint);
  }
}

async function saveImages(client, job, outArg) {
  const saved = [];
  const many = job.images.length > 1;
  let target = outArg || 'comfyui-out';
  let dir = target;
  let base = null;
  const looksFile = /\.(png|jpe?g|webp)$/i.test(target);
  if (looksFile) {
    dir = path.dirname(target);
    base = path.basename(target);
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const img of job.images) {
    const name = base
      ? many
        ? `${base.replace(/\.[^.]+$/, '')}-${img.index}${path.extname(base)}`
        : base
      : `${job.job_id.slice(0, 8)}-${img.index}-${outputName({ images: [img], job_id: job.job_id })}`;
    const file = path.join(dir, name);
    const res = await client.download(`/v1/jobs/${job.job_id}/images/${img.index}`);
    fs.writeFileSync(file, res.body);
    saved.push({ index: img.index, path: path.resolve(file), bytes: res.body.length });
  }
  return saved;
}

// ---- 子命令 ----

async function cmdLogin(argv) {
  const { values } = parse(argv, {
    token: { type: 'string' },
    label: { type: 'string' },
    'no-browser': { type: 'boolean' },
  });
  const url = resolveUrl(values.url);
  const label = values.label?.trim() || os.hostname();

  // 给了共享 token 就直接当凭据存下来：不折腾设备码，老脚本也照跑
  if (values.token?.trim()) {
    const cred = {
      access_token: values.token.trim(),
      token_id: null,
      label,
      scope: 'shared',
      created_at: Date.now() / 1000,
      expires_at: null,
    };
    saveCredential(url, cred);
    return reportLogin(url, cred, values.json);
  }

  const cred = await deviceLogin({
    url,
    label,
    noBrowser: values['no-browser'],
    log: (line) => out(line),
  });
  return reportLogin(url, cred, values.json);
}

function reportLogin(url, cred, asJson) {
  if (asJson) {
    out(
      JSON.stringify(
        { url, token_id: cred.token_id, label: cred.label, expires_at: cred.expires_at },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }
  out(`已登录 ${url}`);
  out(`  token_id: ${cred.token_id ?? '（共享 token，无 id）'}   label: ${cred.label}`);
  out(`  有效期至: ${fmtTime(cred.expires_at)}`);
  out(`  凭据文件: ${authFile()} (0600)`);
  return EXIT.OK;
}

async function cmdLogout(argv) {
  const { values } = parse(argv, { all: { type: 'boolean' } });
  const url = resolveUrl(values.url);
  const { token } = resolveToken(url);
  const finalToken = values.token?.trim() || token;
  if (!finalToken) {
    out(`本机没有 ${url} 的凭据，无需退出`);
    return EXIT.OK;
  }
  const client = createClient({ baseUrl: url, token: finalToken });
  if (values.all) {
    const res = await client.del('/v1/tokens');
    out(`已吊销该服务全部 token：${res.revoked} 枚`);
    clearCredentials();
    out('本地凭据已清空');
    return EXIT.OK;
  }
  try {
    const res = await client.post('/oauth/revoke');
    out(`已吊销 token ${res.token_id ?? ''}${values.token ? '' : '（本地凭据已删除）'}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      out(`服务端未吊销：${e.detail}（共享 token 需要改 .env + 重启服务轮换）`);
    } else if (e instanceof ApiError && e.status === 401) {
      out(`服务端说这枚 token 已失效（HTTP 401），继续清本地凭据`);
    } else {
      throw e;
    }
  }
  if (!values.token) removeCredential(url);
  if (!values.token) out(`本地凭据已从 ${authFile()} 删除`);
  return EXIT.OK;
}

async function cmdWhoami(argv) {
  const { values } = parse(argv);
  const ctx = context(values);
  const me = await ctx.client.get('/v1/auth/whoami');
  if (values.json) {
    out(JSON.stringify({ url: ctx.url, token_source: ctx.source, ...me }, null, 2));
    return EXIT.OK;
  }
  out(`服务: ${ctx.url}`);
  out(`凭据: ${me.kind === 'shared' ? '共享 token' : `设备 token ${me.token_id ?? ''}`}`);
  if (me.label) out(`标签: ${me.label}`);
  if (me.client) out(`客户端: ${me.client}`);
  if (me.kind === 'token') out(`有效期至: ${fmtTime(me.expires_at)}`);
  out(`token 来源: ${ctx.source === 'env' ? '环境变量 COMFYUI_CLI_TOKEN' : ctx.source === 'flag' ? '命令行 --token' : authFile()}`);
  return EXIT.OK;
}

async function cmdTemplates(argv) {
  const { values } = parse(argv);
  const ctx = context(values);
  const { workflows } = await ctx.client.get('/v1/workflows');
  if (values.json) {
    out(JSON.stringify(workflows, null, 2));
    return EXIT.OK;
  }
  if (!workflows.length) out('（服务器没有内置模板）');
  for (const name of workflows) out(name);
  return EXIT.OK;
}

async function cmdStats(argv) {
  const { values } = parse(argv);
  const ctx = context(values);
  const s = await ctx.client.get('/v1/stats');
  if (values.json) {
    out(JSON.stringify(s, null, 2));
    return EXIT.OK;
  }
  out(`排队: ${s.queued} / 上限 ${s.max_queue}`);
  out(s.running ? `进行中: ${s.running.job_id.slice(0, 8)} (${s.running.source || '-'}) 已跑 ${fmtDuration(s.running.running_for_s)}` : '进行中: 无');
  for (const q of s.queued_jobs ?? []) {
    out(`  等待 ${q.job_id.slice(0, 8)} (${q.source || '-'}) ${fmtDuration(q.waiting_s)}`);
  }
  out(`作业超时: ${s.job_timeout_s}s`);
  out(`最近完成: ${s.recent_completed} 个，平均 ${fmtDuration(s.avg_recent_s)}`);
  return EXIT.OK;
}

async function cmdJobs(argv) {
  const { values, positionals } = parse(argv, {
    cancel: { type: 'boolean' },
    limit: { type: 'string' },
    status: { type: 'string' },
  });
  const ctx = context(values);
  const id = positionals[0];
  if (!id) {
    const query = new URLSearchParams();
    if (values.limit) query.set('limit', values.limit);
    if (values.status) query.set('status', values.status);
    const suffix = query.size ? `?${query}` : '';
    const data = await ctx.client.get(`/v1/jobs${suffix}`);
    if (values.json) {
      out(JSON.stringify(data, null, 2));
      return EXIT.OK;
    }
    printJobsTable(data.jobs);
    return EXIT.OK;
  }
  if (values.cancel) {
    const res = await ctx.client.del(`/v1/jobs/${id}`);
    if (values.json) {
      out(JSON.stringify(res, null, 2));
      return EXIT.OK;
    }
    out(res.cancelled ? `已请求取消 ${id}（当前状态 ${res.status}）` : `${id} 已是终态 ${res.status}，无需取消`);
    return EXIT.OK;
  }
  const job = await ctx.client.get(`/v1/jobs/${id}`);
  if (values.json) {
    out(JSON.stringify(job, null, 2));
    return EXIT.OK;
  }
  out(describeJob(job));
  return job.status === 'failed' ? EXIT.JOB_FAILED : EXIT.OK;
}

async function cmdGenerate(argv) {
  const { values } = parse(argv, {
    workflow: { type: 'string', short: 'w' },
    template: { type: 'string', short: 't' },
    prompt: { type: 'string' },
    negative: { type: 'string' },
    steps: { type: 'string' },
    cfg: { type: 'string' },
    size: { type: 'string' },
    seed: { type: 'string' },
    set: { type: 'string', multiple: true },
    out: { type: 'string' },
    'no-wait': { type: 'boolean' },
  });
  if (values.workflow && values.template) {
    throw new UsageError('-w/--workflow 与 -t/--template 只能二选一');
  }
  if (!values.workflow && !values.template) {
    throw new UsageError('需要 -w/--workflow <文件> 或 -t/--template <名称>');
  }
  const num = (name, raw) => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new UsageError(`--${name} 需要数字（收到 ${raw}）`);
    return n;
  };
  let seed = values.seed === 'random' ? randomSeed() : num('seed', values.seed);
  if (seed !== undefined && seed < 0) seed = randomSeed();

  const ctx = context(values);
  let graph;
  let source;
  if (values.template) {
    const name = values.template.replace(/\.json$/, '');
    const data = await ctx.client.get(`/v1/workflows/${encodeURIComponent(name)}`);
    graph = assertApiFormat(data.workflow, `内置模板 ${name}`);
    source = name;
  } else {
    const file = values.workflow;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new UsageError(`读不到工作流文件 ${file}：${e.message}`);
    }
    graph = parseGraph(text, file);
    source = path.basename(file);
  }

  const { overrides, notes } = buildOverrides(graph, {
    prompt: values.prompt,
    negative: values.negative,
    steps: num('steps', values.steps),
    cfg: num('cfg', values.cfg),
    size: values.size,
    seed,
    set: values.set,
  });
  if (!values.json) {
    for (const note of notes) err(`  ${note}`);
    if (seed !== undefined) err(`  seed = ${seed}`);
  }

  const payload = values.template
    ? { workflow_name: values.template.replace(/\.json$/, ''), overrides }
    : { workflow: applyOverrides(graph, overrides) };
  const submitted = await ctx.client.post('/v1/jobs', { body: payload });
  if (values.json && values['no-wait']) {
    out(JSON.stringify(submitted, null, 2));
    return EXIT.OK;
  }
  if (!values.json) {
    out(`已提交 ${submitted.job_id}（来源 ${submitted.source}，排在第 ${submitted.queue_position} 位）`);
  }
  if (values['no-wait']) {
    if (!values.json) out(`不等结果：comfyui jobs ${submitted.job_id}`);
    return EXIT.OK;
  }

  const job = await waitForJob(ctx.client, submitted.job_id, { quiet: values.json });
  if (job.status !== 'completed') {
    if (values.json) {
      out(JSON.stringify({ ...job, images: [] }, null, 2));
    } else {
      err(`作业 ${job.status}${job.error ? `：${job.error}` : ''}`);
    }
    return EXIT.JOB_FAILED;
  }
  const saved = await saveImages(ctx.client, job, values.out);
  if (values.json) {
    out(JSON.stringify({ job_id: job.job_id, status: job.status, elapsed_s: job.elapsed_s, images: saved }, null, 2));
    return EXIT.OK;
  }
  out(`完成（${fmtDuration(job.elapsed_s)}），已保存 ${saved.length} 张：`);
  for (const s of saved) out(`  ${s.path} (${(s.bytes / 1024).toFixed(0)} KB)`);
  return EXIT.OK;
}

async function cmdSkill(argv) {
  const { values } = parse(argv, { out: { type: 'string', short: 'o' } });
  const ctx = context(values);
  const res = await fetch(`${ctx.url}/SKILL.md`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new ApiError(res.status, `取 SKILL.md 失败 (HTTP ${res.status})`);
  const text = await res.text();
  if (values.out) {
    fs.writeFileSync(values.out, text);
    out(`已写入 ${path.resolve(values.out)}（${text.length} 字节）`);
    return EXIT.OK;
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return EXIT.OK;
}

async function cmdConfig(argv) {
  const { values } = parse(argv, { show: { type: 'boolean' } });
  const cfg = loadConfig();
  const url = resolveUrl(values.url);
  const { token, source, cred } = resolveToken(url, cfg);
  const mode = (() => {
    try {
      return (fs.statSync(authFile()).mode & 0o777).toString(8);
    } catch {
      return null;
    }
  })();
  const machine = machineIdentity();
  const info = {
    url,
    token_source: values.token ? 'flag' : source,
    logged_in: Boolean(token || values.token),
    token_id: cred?.token_id ?? null,
    label: cred?.label ?? null,
    expires_at: cred?.expires_at ?? null,
    config_dir: configDir(),
    auth_file: authFile(),
    auth_file_mode: mode,
    machine_file: machineFile(),
    machine_id: machine.id,
    known_servers: Object.keys(cfg.servers),
    default_server: cfg.default,
    default_url: DEFAULT_URL,
  };
  if (values.json) {
    out(JSON.stringify(info, null, 2));
    return EXIT.OK;
  }
  out(`服务地址: ${info.url}${info.url === info.default_url ? '（默认）' : ''}`);
  out(`凭据文件: ${info.auth_file}${mode ? ` (mode ${mode})` : '（不存在）'}`);
  out(`已登录: ${info.logged_in ? `是，token ${info.token_id ?? ''} label ${info.label ?? '-'}，有效期至 ${fmtTime(info.expires_at)}` : '否'}`);
  out(`token 来源: ${info.token_source}`);
  out(`机器指纹: ${info.machine_id}（服务端按它记住注册审批）`);
  if (info.known_servers.length > 1) out(`已知服务: ${info.known_servers.join(', ')}`);
  if (mode && mode !== '600') {
    err(`提示：凭据文件权限是 ${mode}，建议 chmod 600 ${info.auth_file}`);
  }
  return EXIT.OK;
}

/** 把 CLI 自己更新到 npm 上的最新版；开发副本默认只提示不动手。 */
async function cmdUpdate(argv) {
  const { values } = parse(argv, { check: { type: 'boolean' }, force: { type: 'boolean' } });
  const current = version();
  const latest = await latestVersion();
  const newer = compareVersions(latest, current) > 0;
  const kind = installKind();
  const info = {
    current,
    latest,
    update_available: newer,
    install_kind: kind,
    registry: registryUrl(),
    action: 'none',
    command: null,
  };

  const [cmd, args] = installCommand(kind, latest);
  if (!newer) {
    info.action = 'none';
  } else if (values.check) {
    info.action = 'check';
    info.command = [cmd, ...args].join(' ');
  } else if (kind === 'dev' && !values.force) {
    info.action = 'dev-copy';
  } else {
    info.action = 'install';
    info.command = [cmd, ...args].join(' ');
    await runInstall(kind, latest);
  }

  if (values.json) {
    out(JSON.stringify(info, null, 2));
    return EXIT.OK;
  }
  if (!newer) {
    out(`已是最新（${current}）`);
    return EXIT.OK;
  }
  out(`有新版本：${current} → ${latest}`);
  if (info.action === 'check') {
    out(`执行更新：${info.command}`);
  } else if (info.action === 'dev-copy') {
    out('当前是开发链接（npm link）副本，请在仓库里更新；确实想装到全局就加 --force');
  } else {
    out(`已更新到 ${latest}（本进程仍是 ${current}，下次运行生效）`);
  }
  return EXIT.OK;
}

const COMMANDS = {
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  templates: cmdTemplates,
  stats: cmdStats,
  jobs: cmdJobs,
  generate: cmdGenerate,
  skill: cmdSkill,
  config: cmdConfig,
  update: cmdUpdate,
};

function isHelpRequest(argv) {
  return argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h');
}

export async function dispatch(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    out(version());
    return EXIT.OK;
  }
  if (isHelpRequest(argv)) {
    const code = argv.length === 0 && !argv.includes('help') ? EXIT.USAGE : EXIT.OK;
    (code === EXIT.USAGE ? err : out)(HELP.trimEnd());
    return code;
  }
  const [name, ...rest] = argv;
  const handler = COMMANDS[name];
  if (!handler) {
    err(`未知命令: ${name}`);
    err(`可用命令: ${Object.keys(COMMANDS).join(', ')}（comfyui help 看用法）`);
    return EXIT.USAGE;
  }
  return handler(rest);
}

export async function run(argv) {
  let code = EXIT.OK;
  try {
    code = await dispatch(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`用法错误: ${e.message}`);
      code = EXIT.USAGE;
    } else if (e instanceof ApiError) {
      if (e.status === 401) {
        err(`鉴权失败（HTTP 401）：${e.detail}`);
        err(`token 无效或已吊销，重新执行：comfyui login --url ${resolveUrl()}`);
      } else {
        err(`请求失败${e.status ? `（HTTP ${e.status}）` : ''}：${e.detail}`);
      }
      code = EXIT.ERROR;
    } else if (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      err(`用法错误: ${e.message}`);
      code = EXIT.USAGE;
    } else {
      err(`出错: ${e?.message || e}`);
      if (process.env.COMFYUI_CLI_DEBUG) err(e?.stack || '');
      code = EXIT.ERROR;
    }
  }
  process.exitCode = code;
  return code;
}
