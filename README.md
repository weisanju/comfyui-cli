# comfyui-cli

ComfyUI 远程出图的命令行客户端。零运行时依赖（Node ≥ 22.5 内置 `fetch` 与 `parseArgs`），
通过 **OAuth 设备码**登录一次，token 存在本机用户目录，之后所有命令自动带上。

- 服务端：`https://comfyui-api.weisanju.fun`（自托管封装层，见上级 `README.md`）
- 模型：Qwen-Image-2.1 GGUF（AMD RX 7900 XTX），提交工作流 → 轮询 → 下载图片

## 安装

```bash
npm install -g comfyui-cli          # 发布后
# 或从本仓库（源码即时生效）：
cd deploy/comfyui/cli && npm link
```

## 快速开始

```bash
comfyui login --token <共享 token> --label 我的笔记本
# 终端打印设备码（如 4KPC-MKFK）并尝试打开浏览器；在授权页填入共享 token 即可批准
comfyui generate -t qwen-image-2.1-t2i-gguf-api --prompt "雪山下的木屋，清晨薄雾" --steps 12
# → comfyui-out/<job_id>-0.png
```

## 登录与凭据

```bash
comfyui login [--url URL] [--token 共享token] [--label 名称] [--no-browser]
comfyui whoami                 # 当前凭据：kind=shared|token、label、有效期
comfyui config [--show]        # 服务地址、凭据文件路径、登录状态
comfyui logout [--all]         # 吊销当前 token 并删除本地凭据；--all 吊销该服务全部 token
```

- 凭据文件：`~/.config/comfyui/auth.json`（目录 0700，文件 0600），
  按服务地址存 token；`--url` 指定哪个服务就用哪条。
- **发起登录要共享 token**：`--token` > `COMFYUI_CLI_TOKEN` > `COMFYUI_API_TOKEN` >
  交互式隐藏输入（不回显、不进 shell history；非交互终端缺它直接退出码 2）。
  故意不看凭据文件——里面的设备 token 发起不了登录。
- 批准也用同一枚共享 token（服务方的 `COMFYUI_API_TOKEN`）；两道门都用它，
  权限范围没有扩大；发出的是可单独吊销、默认 90 天有效的新 token。
- 也可以用现成的共享 token 免登录：`comfyui --token <shared> …` 或
  `export COMFYUI_CLI_TOKEN=<shared>`（适合 CI）。
- 设备码有效期 10 分钟且只在服务端内存里，超时/服务重启后重跑 `comfyui login` 即可。

## 命令

| 命令 | 说明 |
|---|---|
| `generate` | 提交工作流出图并等待结果 |
| `jobs [ID] [--limit N]` | 列出最近作业；给 ID 看详情；`--cancel` 取消 |
| `stats` | 队列深度 / 当前作业 / 近 20 次平均耗时 |
| `templates` | 列出服务端内置模板名 |
| `skill [-o 文件]` | 取服务端 `/SKILL.md` 调用说明（丢给 AI 代理用） |
| `whoami` / `config` / `logout` | 见上 |

### generate

```bash
# 内置模板 + 常用参数（按 class_type 自动定位到对应节点）
comfyui generate -t qwen-image-2.1-t2i-gguf-api \
  --prompt "民国女学生特写" --negative "模糊" --steps 24 --size 1024x1024 --seed 42

# 自带工作流（ComfyUI 前端「导出（API格式）」的 JSON）
comfyui generate -w my-workflow.json --set 6.denoise=0.5 --out ./out/

# 提交后不等（打印 job_id，之后用 comfyui jobs <id> 查）
comfyui generate -t qwen-image-2.1-t2i-gguf-api --prompt "…" --no-wait

# 机器可读输出
comfyui generate … --json
```

| 选项 | 说明 |
|---|---|
| `-w, --workflow <文件>` | API 格式工作流 JSON；与 `-t` 二选一 |
| `-t, --template <名称>` | 用服务端内置模板（`comfyui templates` 列出） |
| `--prompt` / `--negative` | 正面 / 负面提示词（按 `class_type` 找 TextEncode 节点） |
| `--steps N` / `--cfg N` | 采样步数 / CFG（找 KSampler） |
| `--size 宽x高` | 如 `1024x1024`、`1024×768`（16~8192；模型侧建议取 32 的倍数） |
| `--seed N` | 随机种子，`random` 或负数 = 随机 |
| `--set 节点id.输入=值` | 直接改任意节点输入，可重复；定位不到的参数用它兜底 |
| `--out <目录\|文件>` | 图片保存位置（默认 `./comfyui-out/`） |
| `--no-wait` | 提交后立即返回，不等待出图 |
| `--json` | 输出 JSON（脚本用） |

`--prompt`/`--steps`/`--size` 等按 `class_type` 定位（`KSampler`/`SamplerCustom`、
`*TextEncode*`、`*LatentImage*`），所以内置模板与自带工作流通用；一个工作流里
定位不到或定位错时，用 `--set 6.seed=42` 精确指定。工作流必须是 API 格式，
顶层带 `nodes` 数组的 UI 格式会被本地拦下并提示重新导出。

## 环境变量

| 变量 | 说明 |
|---|---|
| `COMFYUI_CLI_URL` | 服务地址（默认 `https://comfyui-api.weisanju.fun`） |
| `COMFYUI_CLI_TOKEN` | 直接指定 token，跳过凭据文件（共享 token 或设备 token 都行）；`login` 也认它当共享 token |
| `COMFYUI_API_TOKEN` | 服务方的共享 token，`login` 发起登录时兜底用它 |
| `COMFYUI_CLI_CONFIG_DIR` | 凭据目录（默认 `~/.config/comfyui`，测试用） |

优先级：命令行 `--url/--token` > 环境变量 > 凭据文件 > 内置默认地址。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行错误（网络、401/403、服务端 4xx/5xx） |
| 2 | 用法错误（未知命令、参数不合法、工作流不是 API 格式） |
| 3 | 作业本身 failed（如节点校验错误、超时），错误原文来自 ComfyUI |

## 开发

```bash
node --test "test/*.test.js"    # 单元测试（不起服务，36 项）
npm run e2e                     # 端到端（要 API 在跑，21 项：登录→出图→吊销）
node --test test/unit.test.js   # 单个文件
```

`test/e2e.mjs` 需要一个共享 token：`--token` > `COMFYUI_API_TOKEN` > `../../.env`
（即 `deploy/comfyui/.env`）；会自动在临时目录里走完设备码登录，不会动你的真实凭据。
