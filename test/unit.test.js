/** 单元测试：node --test test/  —— 不起服务、不联网（HTTP 部分打本地临时服务） */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'comfyui.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-test-'));
const emptyCfg = path.join(tmpRoot, 'empty');
const credsCfg = path.join(tmpRoot, 'creds');
process.env.COMFYUI_CLI_CONFIG_DIR = emptyCfg;

const { ApiError, UsageError, createClient } = await import('../src/api.js');
const auth = await import('../src/auth.js');
const update = await import('../src/update.js');
const wf = await import('../src/workflow.js');

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const GRAPH = {
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.gguf' } },
  6: {
    class_type: 'CLIPTextEncode',
    inputs: { text: '默认提示词', clip: ['4', 1] },
  },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '低质量', clip: ['4', 1] } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  3: {
    class_type: 'KSampler',
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 4,
      denoise: 1,
      sampler_name: 'euler',
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
};

// Qwen 模板的样子：正负提示词在同一个节点上，输入名是 prompt / negative_prompt
const QWEN_GRAPH = {
  1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'q.gguf' } },
  4: {
    class_type: 'TextEncodeQwenImage21',
    inputs: {
      clip: ['2', 0],
      prompt: '模板默认的狐狸',
      negative_prompt: '低质量',
      resolution: 1024,
    },
  },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  6: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      positive: ['4', 0],
      negative: ['4', 1],
      latent_image: ['5', 0],
      seed: 0,
      steps: 20,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1,
    },
  },
};

describe('workflow: 解析与校验', () => {
  it('接受 API 格式', () => {
    const graph = wf.parseGraph(JSON.stringify(GRAPH), 'x.json');
    assert.equal(graph['3'].class_type, 'KSampler');
  });

  it('界面格式报用法错误', () => {
    assert.throws(
      () => wf.parseGraph(JSON.stringify({ nodes: [], links: [] }), 'ui.json'),
      (e) => e instanceof UsageError && /界面格式/.test(e.message),
    );
  });

  it('坏 JSON 报用法错误', () => {
    assert.throws(() => wf.parseGraph('{oops', 'bad.json'), UsageError);
  });

  it('缺 class_type 报用法错误', () => {
    assert.throws(() => wf.parseGraph(JSON.stringify({ 1: { inputs: {} } }), 'x'), UsageError);
  });
});

describe('workflow: 按 class_type 定位', () => {
  it('找到采样器 / 提示词 / 潜空间', () => {
    assert.equal(wf.findSampler(GRAPH)[0], '3');
    assert.equal(wf.findLatent(GRAPH)[0], '5');
    const { positive, negative } = wf.findTextEncoders(GRAPH);
    assert.equal(positive[0], '6');
    assert.equal(negative[0], '7');
  });

  it('没有连线时按出现顺序退化', () => {
    const graph = structuredClone(GRAPH);
    graph['3'].inputs.positive = undefined;
    graph['3'].inputs.negative = undefined;
    const { positive, negative } = wf.findTextEncoders(graph);
    assert.equal(positive[0], '6');
    assert.equal(negative[0], '7');
  });

  it('识别 SamplerCustom 与带 noise_seed 的节点', () => {
    const graph = {
      '1': { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
      '2': { class_type: 'SamplerCustom', inputs: { noise_seed: ['1', 0] } },
    };
    assert.equal(wf.findSampler(graph)[0], '2');
  });
});

describe('workflow: buildOverrides', () => {
  it('开关映射到正确的节点', () => {
    const { overrides, notes } = wf.buildOverrides(GRAPH, {
      prompt: '雪山',
      negative: '模糊',
      steps: 12,
      cfg: 3.5,
      seed: 42,
      size: '1024x768',
    });
    assert.deepEqual(overrides['6'], { text: '雪山' });
    assert.deepEqual(overrides['7'], { text: '模糊' });
    assert.deepEqual(overrides['3'], { steps: 12, cfg: 3.5, seed: 42 });
    assert.deepEqual(overrides['5'], { width: 1024, height: 768 });
    assert.equal(notes.length, 7);
  });

  it('Qwen 模板按节点实际输入名映射 prompt/negative_prompt', () => {
    const { overrides } = wf.buildOverrides(QWEN_GRAPH, { prompt: '橡皮鸭', negative: '模糊' });
    assert.deepEqual(overrides['4'], { prompt: '橡皮鸭', negative_prompt: '模糊' });
  });

  it('正负同节点时 negative 不会覆盖 prompt 键', () => {
    const { overrides } = wf.buildOverrides(QWEN_GRAPH, { negative: '模糊' });
    assert.deepEqual(overrides['4'], { negative_prompt: '模糊' });
  });

  it('节点没有可写的提示词输入 → 用法错误并列出可用输入', () => {
    const graph = { 6: { class_type: 'KSampler', inputs: { steps: 1, seed: 0 } } };
    assert.throws(
      () => wf.buildOverrides(graph, { prompt: 'x' }),
      (e) => e instanceof UsageError && /找不到提示词节点/.test(e.message),
    );
    const odd = { 9: { class_type: 'TextEncodeWhatever', inputs: { clip: ['1', 0] } } };
    assert.throws(
      () => wf.buildOverrides(odd, { prompt: 'x' }),
      (e) => e instanceof UsageError && /找过 text\/prompt/.test(e.message) && /--set 9\./.test(e.message),
    );
  });

  it('--set 解析 JSON 值', () => {
    const { overrides } = wf.buildOverrides(GRAPH, { set: ['6.text="引号"', '3.denoise=0.5'] });
    assert.equal(overrides['6'].text, '引号');
    assert.equal(overrides['3'].denoise, 0.5);
  });

  it('--set 输入名不在节点上 → 用法错误（写错的名字会被 ComfyUI 静默忽略）', () => {
    assert.throws(
      () => wf.buildOverrides(GRAPH, { set: ['3.newkey=1'] }),
      (e) => e instanceof UsageError && /输入 newkey 不在节点 3/.test(e.message),
    );
    assert.throws(
      () => wf.buildOverrides(GRAPH, { set: ['6.prompt=1'] }),
      (e) => e instanceof UsageError && /可用: text, clip/.test(e.message),
    );
  });

  it('--set 节点不存在 → 用法错误', () => {
    assert.throws(() => wf.buildOverrides(GRAPH, { set: ['99.x=1'] }), /节点 99 不在工作流中/);
  });

  it('--set 格式不对 → 用法错误', () => {
    assert.throws(() => wf.buildOverrides(GRAPH, { set: ['nope'] }), /节点id\.输入名=值/);
  });

  it('工作流没有采样器时 --steps 报错', () => {
    assert.throws(() => wf.buildOverrides({ 1: { class_type: 'SaveImage', inputs: {} } }, { steps: 5 }), UsageError);
  });

  it('applyOverrides 不改原图', () => {
    const out = wf.applyOverrides(GRAPH, { '3': { steps: 1 } });
    assert.equal(out['3'].inputs.steps, 1);
    assert.equal(GRAPH['3'].inputs.steps, 20);
  });

  it('parseSize 校验', () => {
    assert.deepEqual(wf.parseSize('1024×768'), { width: 1024, height: 768 });
    assert.throws(() => wf.parseSize('big'), UsageError);
    assert.throws(() => wf.parseSize('4x4'), /超出范围/);
  });
});

describe('auth: 凭据文件', () => {
  it('写入 0600、读回、覆盖与删除', () => {
    process.env.COMFYUI_CLI_CONFIG_DIR = credsCfg;
    auth.saveCredential('http://127.0.0.1:8199/', {
      access_token: 'comfyui_abc',
      token_id: 'abc',
      label: 'test',
      created_at: 1,
      expires_at: null,
    });
    const file = auth.authFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(auth.loadConfig().default, 'http://127.0.0.1:8199');
    const { token, source } = auth.resolveToken('http://127.0.0.1:8199');
    assert.equal(token, 'comfyui_abc');
    assert.equal(source, 'file');
    auth.saveCredential('http://other:1', { access_token: 'comfyui_x', expires_at: null });
    // 后登录的地址成为默认，其它地址仍各自保留凭据
    assert.equal(auth.loadConfig().default, 'http://other:1');
    assert.equal(auth.resolveToken('http://127.0.0.1:8199').token, 'comfyui_abc');
    auth.removeCredential('http://other:1');
    assert.equal(auth.loadConfig().default, 'http://127.0.0.1:8199');
    auth.removeCredential('http://127.0.0.1:8199');
    assert.equal(auth.resolveToken('http://127.0.0.1:8199').token, '');
    auth.clearCredentials();
    assert.deepEqual(auth.loadConfig().servers, {});
    process.env.COMFYUI_CLI_CONFIG_DIR = emptyCfg;
  });

  it('地址优先级：命令行 > 环境变量 > 配置', () => {
    const isolated = path.join(tmpRoot, 'iso');
    process.env.COMFYUI_CLI_CONFIG_DIR = isolated;
    process.env.COMFYUI_CLI_URL = 'http://env:1';
    assert.equal(auth.resolveUrl('http://flag:1'), 'http://flag:1');
    assert.equal(auth.resolveUrl(), 'http://env:1');
    delete process.env.COMFYUI_CLI_URL;
    assert.equal(auth.resolveUrl(), auth.DEFAULT_URL);
    process.env.COMFYUI_CLI_CONFIG_DIR = emptyCfg;
  });

  it('COMFYUI_CLI_TOKEN 覆盖文件凭据', () => {
    process.env.COMFYUI_CLI_CONFIG_DIR = credsCfg;
    auth.saveCredential('http://u:1', { access_token: 'comfyui_file', expires_at: null });
    process.env.COMFYUI_CLI_TOKEN = 'comfyui_env';
    assert.equal(auth.resolveToken('http://u:1').source, 'env');
    delete process.env.COMFYUI_CLI_TOKEN;
    assert.equal(auth.resolveToken('http://u:1').source, 'file');
    auth.clearCredentials();
    process.env.COMFYUI_CLI_CONFIG_DIR = emptyCfg;
  });

  it('过期判断', () => {
    assert.equal(auth.isExpired({ expires_at: Math.floor(Date.now() / 1000) - 1 }), true);
    assert.equal(auth.isExpired({ expires_at: Math.floor(Date.now() / 1000) + 60 }), false);
    assert.equal(auth.isExpired({ expires_at: null }), false);
  });
});

describe('api: HTTP 客户端', () => {
  let server;
  let base;
  const seen = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
        if (req.url === '/ok') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ hello: 'world' }));
        } else if (req.url === '/form') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: req.headers['content-type'], body }));
        } else if (req.url === '/boom') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: '缺少或错误的 Bearer token' }));
        } else if (req.url === '/oauth-err') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'authorization_pending', error_description: '还在等' }));
        } else if (req.url === '/image') {
          res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'inline; filename="a.png"' });
          res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        } else if (req.url === '/text') {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('upstream exploded');
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: 'Not Found' }));
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it('GET + Bearer + JSON', async () => {
    const client = createClient({ baseUrl: `${base}/`, token: 'comfyui_t' });
    assert.deepEqual(await client.get('/ok'), { hello: 'world' });
    assert.equal(seen.at(-1).auth, 'Bearer comfyui_t');
  });

  it('表单编码', async () => {
    const client = createClient({ baseUrl: base });
    const data = await client.post('/form', { form: { grant_type: 'g', device_code: 'd' } });
    assert.match(data.type, /x-www-form-urlencoded/);
    assert.equal(data.body, 'grant_type=g&device_code=d');
  });

  it('错误体取 detail', async () => {
    const client = createClient({ baseUrl: base });
    await assert.rejects(
      () => client.get('/boom'),
      (e) => e instanceof ApiError && e.status === 401 && /Bearer token/.test(e.detail),
    );
  });

  it('OAuth 错误取 error / error_description', async () => {
    const client = createClient({ baseUrl: base });
    await assert.rejects(
      () => client.get('/oauth-err'),
      (e) => e.code === 'authorization_pending' && e.detail === '还在等',
    );
  });

  it('非 JSON 错误体退化成文本', async () => {
    const client = createClient({ baseUrl: base });
    await assert.rejects(() => client.get('/text'), (e) => e.status === 500 && /upstream exploded/.test(e.detail));
  });

  it('下载带文件名与字节', async () => {
    const client = createClient({ baseUrl: base });
    const res = await client.download('/image');
    assert.equal(res.filename, 'a.png');
    assert.equal(res.body.length, 4);
  });

  it('连不上时报中文网络错误', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(() => client.get('/ok'), (e) => e.status === 0 && /连接被拒绝/.test(e.detail));
  });
});

const runCliWith = async (env, ...args) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 15_000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
};

describe('cli: 退出码与提示', () => {
  const env = { ...process.env, COMFYUI_CLI_CONFIG_DIR: emptyCfg };
  const runCli = (...args) => runCliWith(env, ...args);

  it('--version → 0 且打印版本号', async () => {
    const r = await runCli('--version');
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('help → 0', async () => {
    const r = await runCli('help');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /comfyui — ComfyUI 远程出图 CLI/);
  });

  it('没有参数 → 2 且打印用法', async () => {
    const r = await runCli();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /用法: comfyui <命令>/);
  });

  it('未知命令 → 2', async () => {
    const r = await runCli('frobnicate');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /未知命令: frobnicate/);
  });

  it('未知选项 → 2', async () => {
    const r = await runCli('stats', '--nope');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /用法错误/);
  });

  it('generate 缺 -w/-t → 2', async () => {
    const r = await runCli('generate', '--prompt', 'x');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /需要 -w\/--workflow <文件> 或 -t\/--template <名称>/);
  });

  it('未登录时 whoami → 2 并提示先登录', async () => {
    const r = await runCli('whoami', '--url', 'http://127.0.0.1:8199');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /comfyui login --url http:\/\/127\.0\.0\.1:8199/);
  });

  it('login 不再要求先给 token：连不上就是运行错误（退出码 1）', async () => {
    const bare = { ...env };
    delete bare.COMFYUI_CLI_TOKEN;
    delete bare.COMFYUI_API_TOKEN;
    const r = await runCliWith(bare, 'login', '--url', 'http://127.0.0.1:8199', '--no-browser');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /连接被拒绝|请求失败/);
  });

  it('login --token 直接把共享 token 存成凭据（不发设备码）', async () => {
    const iso = path.join(tmpRoot, 'shared-login');
    const r = await runCliWith(
      { ...env, COMFYUI_CLI_CONFIG_DIR: iso },
      'login',
      '--url',
      'http://shared:8199',
      '--token',
      'shared-x',
      '--label',
      'ci',
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /已登录/);
    const cred = JSON.parse(fs.readFileSync(path.join(iso, 'auth.json'), 'utf8'));
    assert.equal(cred.servers['http://shared:8199'].access_token, 'shared-x');
    assert.equal(cred.servers['http://shared:8199'].scope, 'shared');
  });

  it('config --json 显示凭据路径与未登录状态', async () => {
    const r = await runCli('config', '--json');
    assert.equal(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.logged_in, false);
    assert.equal(data.auth_file, path.join(emptyCfg, 'auth.json'));
  });

  it('--seed 支持负数与 random', async () => {
    const r = await runCli('generate', '-t', 'x', '--seed', '-1', '--url', 'http://127.0.0.1:8199', '--token', 't');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /请求失败|连接被拒绝/);
  });

  it('--no-wait 提交后立即返回，不轮询作业', async () => {
    const polls = [];
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/jobs') {
        res.writeHead(202);
        res.end(JSON.stringify({ job_id: 'j1', status: 'queued', queue_position: 1, source: 'tpl' }));
      } else if (req.url === '/v1/workflows/tpl') {
        res.writeHead(200);
        res.end(JSON.stringify({ workflow: GRAPH }));
      } else {
        polls.push(req.url);
        res.writeHead(200);
        res.end(JSON.stringify({ job_id: 'j1', status: 'running' }));
      }
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [CLI, 'generate', '-t', 'tpl', '--prompt', '雪山', '--no-wait', '--url', url, '--token', 'comfyui_t'],
        { env, timeout: 8000 },
      );
      assert.match(stdout, /不等结果/);
      assert.equal(polls.length, 0);
    } finally {
      srv.close();
    }
  });

  it('login 走两段审批：等注册审批 → 等设备确认 → 拿到 token', async () => {
    const polls = { n: 0 };
    let codeBody = null;
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        if (req.url === '/oauth/device/code') {
          codeBody = JSON.parse(raw);
          res.writeHead(200);
          res.end(
            JSON.stringify({
              device_code: 'd',
              user_code: 'AAAA-BBBB',
              registration_required: true,
              verification_uri: `${url}/oauth/register?user_code=AAAA-BBBB`,
              verification_uri_complete: `${url}/oauth/register?user_code=AAAA-BBBB`,
              registration_uri: `${url}/oauth/register?user_code=AAAA-BBBB`,
              device_uri: `${url}/oauth/device?user_code=AAAA-BBBB`,
              interval: 1,
              expires_in: 60,
            }),
          );
        } else if (req.url === '/oauth/token') {
          polls.n += 1;
          if (polls.n === 1) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'registration_pending', error_description: '还没批注册' }));
          } else if (polls.n === 2) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'authorization_pending', error_description: '还没确认设备' }));
          } else {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                access_token: 'comfyui_new',
                token_type: 'Bearer',
                token_id: 't1',
                label: 'laptop',
                scope: 'comfyui',
                expires_in: 3600,
              }),
            );
          }
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ detail: 'Not Found' }));
        }
      });
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const iso = path.join(tmpRoot, 'device-login');
    try {
      const { stdout } = await execFileAsync(process.execPath, [CLI, 'login', '--url', url, '--no-browser'], {
        env: { ...env, COMFYUI_CLI_CONFIG_DIR: iso },
        timeout: 15_000,
      });
      assert.match(stdout, /还没登记，先让持有 access code 的人批准注册/);
      assert.match(stdout, /设备码: AAAA-BBBB/);
      assert.match(stdout, /请手动打开/);
      assert.match(stdout, /等待注册审批/);
      assert.match(stdout, /注册已通过，请在浏览器里确认/);
      assert.match(stdout, /已登录/);
    } finally {
      srv.close();
    }
    // 机器指纹随申请上报，服务端按它记住注册审批
    assert.match(codeBody.client_id, /^[0-9a-f]{32}$/, JSON.stringify(codeBody));
    assert.equal(codeBody.hostname, os.hostname());
    const machine = JSON.parse(fs.readFileSync(path.join(iso, 'machine.json'), 'utf8'));
    assert.equal(machine.id, codeBody.client_id);
    assert.equal(fs.statSync(path.join(iso, 'machine.json')).mode & 0o777, 0o600);
    // 再跑一次：同一个机器指纹（不重新生成）
    const again = await execFileAsync(process.execPath, [CLI, 'config', '--json'], {
      env: { ...env, COMFYUI_CLI_CONFIG_DIR: iso },
    });
    assert.equal(JSON.parse(again.stdout).machine_id, codeBody.client_id);
  });
});

describe('share: 分享链接', () => {
  const env = { ...process.env, COMFYUI_CLI_CONFIG_DIR: emptyCfg };
  let srv;
  let base;
  const seen = [];

  const PAYLOAD = {
    job_id: 'j1',
    expires_in: 1800,
    expires_at: 1800000000,
    images: [
      { index: 0, filename: 'a_00001.png', url: 'https://api.example/public/jobs/j1/images/0?exp=1&sig=x' },
      { index: 1, filename: 'a_00002.png', url: 'https://api.example/public/jobs/j1/images/1?exp=1&sig=y' },
    ],
  };

  before(async () => {
    srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/jobs/j1/share') {
          res.writeHead(200);
          res.end(JSON.stringify(PAYLOAD));
        } else if (req.url === '/v1/jobs/empty/share') {
          res.writeHead(400);
          res.end(JSON.stringify({ detail: '作业还没有图片（出图完成后才能分享）' }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ detail: '未知的 job_id（仅保留最近 200 条终结作业）' }));
        }
      });
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  after(() => srv?.close());

  const runShare = (...args) => runCliWith(env, 'share', ...args, '--url', base, '--token', 'comfyui_t');

  it('--ttl 30m 换算成秒发给服务端，打印每条链接', async () => {
    const r = await runShare('j1', '--ttl', '30m');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.at(-1).auth, 'Bearer comfyui_t');
    assert.deepEqual(JSON.parse(seen.at(-1).body), { ttl: 1800 });
    assert.match(r.stdout, /30m00s内有效/);
    assert.match(r.stdout, /\[1\] https:\/\/api\.example\/public\/jobs\/j1\/images\/1\?exp=1&sig=y/);
  });

  it('不带 --ttl 就不传字段（用服务端默认）', async () => {
    const r = await runShare('j1', '--json');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(seen.at(-1).body), {});
    assert.equal(JSON.parse(r.stdout).images.length, 2);
  });

  it('缺 job_id / --ttl 不合法 / 低于 60 秒 → 2（用法错误）', async () => {
    const missing = await runShare();
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /用法: comfyui share <job_id>/);
    for (const bad of ['abc', '30', '30s', '2x']) {
      const r = await runShare('j1', '--ttl', bad);
      assert.equal(r.code, 2, `--ttl ${bad}`);
      assert.match(r.stderr, /--ttl/);
    }
  });

  it('作业还没出图 → 1 并原样带出服务端提示', async () => {
    const r = await runShare('empty');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /作业还没有图片/);
  });
});

describe('update: 自更新', () => {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
  let srv;
  let registryVersion = '0.2.0';
  let envRegistry;
  let npmLog;
  let env;

  before(async () => {
    srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: registryVersion }));
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    envRegistry = `http://127.0.0.1:${srv.address().port}`;
    npmLog = path.join(tmpRoot, 'npm.log');
    const fakeBin = path.join(tmpRoot, 'fakebin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\necho "$@" >> "$NPM_LOG"\nexit 0\n', { mode: 0o755 });
    env = {
      ...process.env,
      COMFYUI_CLI_CONFIG_DIR: emptyCfg,
      COMFYUI_CLI_REGISTRY: envRegistry,
      NPM_LOG: npmLog,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
  });

  after(() => srv?.close());

  const npmCalls = () =>
    fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean) : [];

  it('版本比较只看数字段', () => {
    assert.equal(update.compareVersions('0.2.0', '0.1.9'), 1);
    assert.equal(update.compareVersions('0.1.0', '0.1.0'), 0);
    assert.equal(update.compareVersions('0.1.0', '0.10.0'), -1);
    assert.equal(update.compareVersions('0.2.0-rc.1', '0.2.0'), 0);
  });

  it('从仓库跑的是开发副本', () => {
    assert.equal(update.installKind(), 'dev');
  });

  it('开发副本只提示、不装', async () => {
    const r = await runCliWith(env, 'update', '--json');
    const info = JSON.parse(r.stdout);
    assert.equal(r.code, 0);
    assert.equal(info.update_available, true);
    assert.equal(info.action, 'dev-copy');
    assert.equal(info.install_kind, 'dev');
    assert.deepEqual(npmCalls(), []);
  });

  it('--force 才真的调 npm 装指定版本（带上 registry）', async () => {
    const r = await runCliWith(env, 'update', '--json', '--force');
    const info = JSON.parse(r.stdout);
    assert.equal(info.action, 'install');
    assert.equal(info.registry, envRegistry);
    assert.equal(info.command, `npm install -g comfyui-cli@0.2.0 --registry ${envRegistry}`);
    assert.deepEqual(npmCalls(), [`install -g comfyui-cli@0.2.0 --registry ${envRegistry}`]);
  });

  it('registry 上就是当前版本 → 不装', async () => {
    registryVersion = pkgVersion;
    try {
      const r = await runCliWith(env, 'update');
      assert.equal(r.code, 0);
      assert.match(r.stdout, new RegExp(`已是最新（${pkgVersion.replace(/\./g, '\\.')}）`));
      assert.deepEqual(npmCalls(), [`install -g comfyui-cli@0.2.0 --registry ${envRegistry}`]); // 还是上一条留下的那次
    } finally {
      registryVersion = '0.2.0';
    }
  });

  it('registry 连不上 → 运行错误（退出码 1）', async () => {
    const dead = http.createServer();
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${dead.address().port}`;
    await new Promise((resolve) => dead.close(resolve));
    const r = await runCliWith({ ...env, COMFYUI_CLI_REGISTRY: url }, 'update', '--check');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /连不上 npm|请求失败/);
  });

  it('registry 归一化：去空格与尾斜杠，未指定时回落到官方源', () => {
    assert.equal(update.registryOverride('  https://mirror.example//  '), 'https://mirror.example');
    assert.equal(update.registryUrl('https://mirror.example/'), 'https://mirror.example');
    const old = process.env.COMFYUI_CLI_REGISTRY;
    delete process.env.COMFYUI_CLI_REGISTRY;
    try {
      assert.equal(update.registryOverride(''), '');
      assert.equal(update.registryUrl(), 'https://registry.npmjs.org');
    } finally {
      if (old !== undefined) process.env.COMFYUI_CLI_REGISTRY = old;
    }
  });

  it('installCommand 只在给了 registry 时追加 --registry', () => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    assert.deepEqual(update.installCommand('npm', '1.2.3'), [npm, ['install', '-g', 'comfyui-cli@1.2.3']]);
    assert.deepEqual(update.installCommand('npm', '1.2.3', 'https://mirror.example'), [
      npm,
      ['install', '-g', 'comfyui-cli@1.2.3', '--registry', 'https://mirror.example'],
    ]);
    // yarn 不认 --registry，改走 YARN_REGISTRY 环境变量（见 runInstall）
    assert.deepEqual(update.installCommand('yarn', '1.2.3', 'https://mirror.example'), [
      'yarn',
      ['global', 'add', 'comfyui-cli@1.2.3'],
    ]);
  });

  it('--registry 覆盖环境变量且传给安装命令', async () => {
    const other = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: '0.3.0' }));
    });
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${other.address().port}`;
    try {
      const r = await runCliWith(env, 'update', '--json', '--force', '--registry', `${url}//`);
      const info = JSON.parse(r.stdout);
      assert.equal(r.code, 0);
      assert.equal(info.latest, '0.3.0'); // 来自 --registry 那个源，不是 env 里的 0.2.0
      assert.equal(info.registry, url);
      assert.equal(info.command, `npm install -g comfyui-cli@0.3.0 --registry ${url}`);
      assert.deepEqual(npmCalls().at(-1), `install -g comfyui-cli@0.3.0 --registry ${url}`);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });
});
