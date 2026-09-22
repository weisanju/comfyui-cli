/** 工作流工具：按 class_type 定位节点，把 --prompt/--steps/... 翻译成 overrides。 */

import { UsageError } from './api.js';

const SAMPLER_RE = /^(KSampler|SamplerCustom)/i;
const ENCODER_RE = /TextEncode/i;
const LATENT_RE = /LatentImage/i;

export function parseGraph(text, source = '工作流文件') {
  let graph;
  try {
    graph = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${source} 不是合法 JSON：${err.message}`);
  }
  assertApiFormat(graph, source);
  return graph;
}

export function assertApiFormat(graph, source = '工作流') {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new UsageError(`${source} 必须是一个对象：{节点id: {class_type, inputs}}`);
  }
  if (Array.isArray(graph.nodes)) {
    throw new UsageError(
      `${source} 看起来是「界面格式」；请在 ComfyUI 编辑器里用「导出（API格式）」再提交`,
    );
  }
  for (const [id, node] of Object.entries(graph)) {
    if (!node || typeof node !== 'object' || !node.class_type) {
      throw new UsageError(`${source} 的节点 ${id} 缺少 class_type`);
    }
    if (node.inputs === undefined) node.inputs = {};
    if (Array.isArray(node.inputs) || typeof node.inputs !== 'object') {
      throw new UsageError(`${source} 的节点 ${id} 的 inputs 必须是对象`);
    }
  }
  return graph;
}

const entries = (graph) => Object.entries(graph);

export function findSampler(graph) {
  return (
    entries(graph).find(([, n]) => SAMPLER_RE.test(n.class_type)) ??
    entries(graph).find(([, n]) => /sampl/i.test(n.class_type)) ??
    null
  );
}

function linkTarget(graph, value) {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
    return graph[value[0]] ? [value[0], graph[value[0]]] : null;
  }
  return null;
}

/** 找正/负提示词节点：优先跟采样器的 positive/negative 连线走，退化到出现顺序。 */
export function findTextEncoders(graph) {
  const sampler = findSampler(graph);
  let positive = sampler ? linkTarget(graph, sampler[1].inputs?.positive) : null;
  let negative = sampler ? linkTarget(graph, sampler[1].inputs?.negative) : null;
  const encoders = entries(graph).filter(([, n]) => ENCODER_RE.test(n.class_type));
  const taken = new Set([positive?.[0], negative?.[0]].filter(Boolean));
  if (!positive) positive = encoders.find(([id]) => !taken.has(id)) ?? null;
  if (!negative) {
    negative = encoders.find(([id]) => !taken.has(id) && id !== positive?.[0]) ?? null;
  }
  return { positive, negative };
}

export function findLatent(graph) {
  return (
    entries(graph).find(
      ([, n]) => LATENT_RE.test(n.class_type) && 'width' in (n.inputs ?? {}),
    ) ?? null
  );
}

function seedNode(graph, sampler) {
  if (!sampler) return null;
  if ('seed' in (sampler[1].inputs ?? {}) || 'noise_seed' in (sampler[1].inputs ?? {})) {
    return sampler;
  }
  const noise = entries(graph).find(([, n]) => 'noise_seed' in (n.inputs ?? {}));
  return noise ?? sampler;
}

function coerce(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseSize(text) {
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(text).trim());
  if (!m) throw new UsageError(`--size 需要 宽x高 形式，例如 1024x1024（收到 ${text}）`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 16 || height < 16 || width > 8192 || height > 8192) {
    throw new UsageError(`--size 超出范围（16~8192）：${text}`);
  }
  return { width, height };
}

function put(overrides, id, key, value, notes, label) {
  overrides[id] = { ...(overrides[id] ?? {}), [key]: value };
  notes.push(`${label} → 节点 ${id}.${key} = ${JSON.stringify(value)}`);
}

/** 把命令行开关翻成 {节点id: {输入名: 值}}；找不到目标节点时报用法错误。 */
export function buildOverrides(graph, opts = {}) {
  const overrides = {};
  const notes = [];
  const sampler = findSampler(graph);
  const { positive, negative } = findTextEncoders(graph);
  const latent = findLatent(graph);

  if (opts.prompt !== undefined) {
    if (!positive) throw new UsageError('工作流里找不到提示词节点，请改用 --set 节点id.text=…');
    put(overrides, positive[0], 'text', opts.prompt, notes, 'prompt');
  }
  if (opts.negative !== undefined) {
    if (!negative) throw new UsageError('工作流里找不到负面提示词节点，请改用 --set 节点id.text=…');
    put(overrides, negative[0], 'text', opts.negative, notes, 'negative');
  }
  if (opts.steps !== undefined) {
    if (!sampler || !('steps' in (sampler[1].inputs ?? {}))) {
      throw new UsageError('工作流里找不到带 steps 的采样器，请改用 --set 节点id.steps=…');
    }
    put(overrides, sampler[0], 'steps', opts.steps, notes, 'steps');
  }
  if (opts.cfg !== undefined) {
    if (!sampler || !('cfg' in (sampler[1].inputs ?? {}))) {
      throw new UsageError('工作流里找不到带 cfg 的采样器，请改用 --set 节点id.cfg=…');
    }
    put(overrides, sampler[0], 'cfg', opts.cfg, notes, 'cfg');
  }
  if (opts.seed !== undefined) {
    const target = seedNode(graph, sampler);
    if (!target) throw new UsageError('工作流里找不到 seed / noise_seed，请改用 --set 节点id.seed=…');
    const key = 'seed' in (target[1].inputs ?? {}) ? 'seed' : 'noise_seed';
    put(overrides, target[0], key, opts.seed, notes, 'seed');
  }
  if (opts.size !== undefined) {
    if (!latent) {
      throw new UsageError('工作流里找不到带 width/height 的潜空间节点，请改用 --set');
    }
    const { width, height } = parseSize(opts.size);
    put(overrides, latent[0], 'width', width, notes, 'size');
    put(overrides, latent[0], 'height', height, notes, 'size');
  }
  for (const item of opts.set ?? []) {
    const m = /^([^.=\s]+)\.([^.=\s]+)\s*=\s*(.*)$/s.exec(item);
    if (!m) throw new UsageError(`--set 需要 节点id.输入名=值 形式（收到 ${item}）`);
    const [, id, key, raw] = m;
    if (!graph[id]) throw new UsageError(`--set 里的节点 ${id} 不在工作流中`);
    if (!(key in (graph[id].inputs ?? {}))) {
      notes.push(`（提示）节点 ${id} 原本没有输入 ${key}，仍按值写入`);
    }
    put(overrides, id, key, coerce(raw), notes, 'set');
  }
  return { overrides, notes };
}

export function applyOverrides(graph, overrides) {
  const out = structuredClone(graph);
  for (const [id, patch] of Object.entries(overrides)) {
    Object.assign(out[id].inputs, patch);
  }
  return out;
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

/** 从作业结果里挑一个文件名，用于 --out 的默认命名。 */
export function outputName(job, source) {
  const first = job.images?.[0]?.filename;
  if (first) return first.replace(/\.[^.]+$/, '.png');
  const stem = String(source || job.source || job.job_id).replace(/\.json$/i, '');
  return `${stem}.png`;
}
