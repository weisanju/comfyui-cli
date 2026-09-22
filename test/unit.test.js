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
      sampler_name: 'euler',
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
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

  it('--set 解析 JSON 值，未知输入只提示不报错', () => {
    const { overrides, notes } = wf.buildOverrides(GRAPH, { set: ['6.text="引号"', '3.denoise=0.5', '3.newkey=1'] });
    assert.equal(overrides['6'].text, '引号');
    assert.equal(overrides['3'].denoise, 0.5);
    assert.ok(notes.some((n) => /原本没有输入 newkey/.test(n)));
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

describe('cli: 退出码与提示', () => {
  const env = { ...process.env, COMFYUI_CLI_CONFIG_DIR: emptyCfg };
  const runCli = async (...args) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env });
      return { code: 0, stdout, stderr };
    } catch (e) {
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };

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

  it('login 没有共享 token（非交互）→ 2，不发设备码请求', async () => {
    const bare = { ...env };
    delete bare.COMFYUI_CLI_TOKEN;
    delete bare.COMFYUI_API_TOKEN;
    try {
      await execFileAsync(process.execPath, [CLI, 'login', '--url', 'http://127.0.0.1:8199', '--no-browser'], { env: bare });
      assert.fail('应该以用法错误退出');
    } catch (e) {
      assert.equal(e.code, 2);
      assert.match(e.stderr, /发起登录需要共享 token/);
    }
  });

  it('login 带 --token 会真的去发起设备码', async () => {
    const bare = { ...env };
    delete bare.COMFYUI_CLI_TOKEN;
    delete bare.COMFYUI_API_TOKEN;
    try {
      const { stderr } = await execFileAsync(
        process.execPath,
        [CLI, 'login', '--url', 'http://127.0.0.1:8199', '--token', 'shared-x', '--no-browser'],
        { env: bare },
      );
      assert.fail(`不该成功：${stderr}`);
    } catch (e) {
      assert.equal(e.code, 1);
      assert.match(e.stderr, /连接被拒绝|请求失败/);
    }
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
});
