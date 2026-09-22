/** 自更新：查 npm registry 上的最新版本，必要时调包管理器重新全局安装自己。 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ApiError } from './api.js';

export const PKG_NAME = 'comfyui-cli';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 显式指定的 registry（`--registry` > `COMFYUI_CLI_REGISTRY`），没指定返回空串。 */
export function registryOverride(explicit) {
  return (explicit?.trim() || process.env.COMFYUI_CLI_REGISTRY?.trim() || '').replace(/\/+$/, '');
}

export function registryUrl(explicit) {
  return registryOverride(explicit) || DEFAULT_REGISTRY;
}

export async function latestVersion(explicit) {
  const url = `${registryUrl(explicit)}/${PKG_NAME}/latest`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new ApiError(0, `连不上 npm（${url}）：${e.message}；离线安装请用 npm install -g ${PKG_NAME}@latest`);
  }
  if (!res.ok) throw new ApiError(res.status, `从 ${url} 取版本失败`);
  const data = await res.json().catch(() => null);
  if (!data?.version) throw new ApiError(0, `${url} 的返回里没有 version 字段`);
  return data.version;
}

/** 只比数字段：0.2.0-rc.1 视作 0.2.0。 */
export function compareVersions(a, b) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 自己是怎么装上的：npm / pnpm / yarn / dev。
 * npm link 的软链已被 Node 在解析模块时展开，所以指向仓库的副本会露出「不在 node_modules 里」。
 */
export function installKind() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (root.includes(`${path.sep}pnpm${path.sep}`)) return 'pnpm';
  if (root.includes(`${path.sep}.yarn${path.sep}`) || root.includes(`${path.sep}yarn${path.sep}global${path.sep}`)) return 'yarn';
  return root.includes(`${path.sep}node_modules${path.sep}`) ? 'npm' : 'dev';
}

export function installCommand(kind, version, registry) {
  const pkg = `${PKG_NAME}@${version}`;
  const flag = registry ? ['--registry', registry] : [];
  if (kind === 'pnpm') return ['pnpm', ['add', '-g', pkg, ...flag]];
  // yarn 不支持 --registry，改由 runInstall 传 YARN_REGISTRY 环境变量
  if (kind === 'yarn') return ['yarn', ['global', 'add', pkg]];
  return [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', pkg, ...flag]];
}

/** 跑安装命令，输出直接接到当前终端（npm 的进度、报错都看得到）。 */
export function runInstall(kind, version, registry) {
  const [cmd, args] = installCommand(kind, version, registry);
  const env = kind === 'yarn' && registry ? { ...process.env, YARN_REGISTRY: registry } : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env });
    child.on('error', (e) => reject(new ApiError(0, `执行 ${cmd} 失败：${e.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new ApiError(0, `${cmd} ${args.join(' ')} 退出码 ${code}`)),
    );
  });
}
