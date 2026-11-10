# dsh-blob-pet · DSH 桌宠（grok-icon-study 引擎版）

挂在 DSH 界面右下角的黑色小团子：**跟着 agent 的真实活动换表情动作**。

## 它会做什么

| agent 状态 | 团子反应（引擎真实状态名） |
|---|---|
| 你发了消息 | `listening` + 弹一下（bounceOnce trick） |
| 模型推理中 | `thinking`（4 套眼睛轮换 + **dots 省略号 overlay**） |
| 模型出正文 | `dictating`（**wave 声波 overlay**，逐字念话） |
| 跑命令 | `working`；连续同类切 `searching`（6 眼快速搜寻） |
| 读写/搜文件 | `searching`（眼 15→9→3→20→12→18 轮换） |
| 写文件/改代码 | `writing`（**pencil 铅笔 overlay** + emphasis 强调） |
| 装插件/载依赖 | `uploading`（**dock 坞接 overlay**） |
| 读网页/压缩记忆 | `loading`（**whirl 漩涡 overlay**） |
| 派分身/组队 | `spawning`（**gather 汇聚 overlay**，2s 一循环） |
| 分身汇报 | `receiving`（**receive overlay**） |
| present 交付 | `sending`（**send 发射 overlay**） |
| 立目标/闹钟 | `radar`（**radar 雷达 overlay**） |
| 看团队 | `orbit`（**orbit 环绕 overlay**） |
| 排计划 | `progress`（**环形进度 overlay** + emphasis） |
| 问你问题 | `notifying`（3→21 惊眼 + 气泡） |
| 等你批准 | `alerting`（**bang 惊叹号 overlay**） |
| 回合完成 | `celebrate` + **burstOnce 粒子爆发** → `proud` → `bored`；连续 3 次触发 **spinOnce 转圈** |
| 请求失败 | `scared` → `confused` → `sad` 三段哀悼 |
| 拖拽 / 松手 | `dragging` / 落下 `bouncing`（**ball 弹跳 overlay**） |
| 点一下摸头 | 5 连击轮换：`happy`→`playful`→`laughing`→`excited`→`shy` + bounceOnce |
| 空闲 90s | 引擎 onboarding 轮换（idle↔8 种表情，每 1200ms，含 wink 随机单眼眨） |
| 空闲 4/5/12 分钟 | `drowsy` → `sleeping` → `powering-down`（**standby 待机 overlay**） |
| 睡着被叫 | 他真实的 `waking` 起床态（眼 13，800ms）+「啊？叫我？」 |

39 个引擎状态里映射了 35 个；15 种 overlay 特效里用到 12 种；
spin/bounce/burst 三个 trick API 全接入。

## 实现分工

- **形象引擎 = blessonism/grok-icon-study 的复刻实现，逐字节原样**（`web/grok/` 8 个文件）：
  几何数据（25 套眼睛 / 18 种身形 / 11 色板）、弹簧参数、`EYE_PLAYLIST` /
  `EYE_HOLD_MS` / `BLINK_MS` 节奏表、pose/tricks/fx/eyes/math/tables/character 全套。
- 本插件的原创部分只有两层：
  - `lib/index.js`：DSH 宿主事件（session/event + assistant-stream）→ SSE `/blob-pet/events`；
    `tapIndex` + `webserver/index-inject` 双通道注入。
  - `web/pet.js`：agent 活动 → 他的状态名的映射表 + 气泡/拖拽/摸头交互。
- `/blob-pet/pet.js` 由宿主把 9 个文件拼成单文档下发（mtime 签名缓存，改任一文件刷新即生效）。
- 想换身形/颜色：`web/pet.js` 里 `new GrokCharacter(svg, {shape:'blob', color:'black'})`
  改成 `GROK_GEO.shapes` / `palette` 里任意的 18 种 × 11 色。

## 安装

克隆后本地 link 进 DSH（DSH 插件以目录形式挂载）：

```bash
git clone https://github.com/vvvvfwww/dsh-blob-pet.git
dsh plugin --profile desktop add "link:<克隆路径>/dsh-blob-pet"
```

卸载：

```bash
dsh plugin --profile desktop remove dsh-blob-pet
```

> 依赖：本机 Python 3.13 + PySide6（原生窗渲染）；Node 走 DSH 自带运行时，无需额外安装。

## 原生桌宠窗（默认形态，不是浏览器/不是 web）

**DSH 启动 = 团子自动出现**，全程无浏览器窗口。**引擎跑在 DSH 宿主进程内**
（`node:vm` 沙箱隔离，`tools/engine-core.cjs`），团子窗是纯显示端
（PySide6 + QSvgRenderer）——**没有 node 子进程**，整机只多一个 pythonw
（约 60MB 内存、约 3% 单核）：

```
DSH 宿主（引擎+39态状态机，/frames NDJSON 60fps）──▶ tools/pet-native.py（透明置顶窗）
        ▲ session/event / assistant-stream
        └── DSH 会话真实活动（user/推理/工具/批准/完成/失败）
```

- sidecar 路由：`/frames?k=`（ndjson 帧流，主通道）、`/pet?cmd=pet|show`
  （摸头/表演）、`/cmd`（拖拽/显示隐藏等交互）、`/state`（当前状态）、
  `/gallery`、`/grok/*`（图鉴资源）。
  另有 GUI 注入通道 `/blob-pet/*`（`/blob-pet/pet.js` 单文档、`/blob-pet/events` SSE），仅当 `{"gui": true}` 时启用。
- 无订阅者时引擎循环自动停摆，不烧 CPU。
- 生命周期：spawn 带 `--parent-pid`，DSH 宿主退出 → 窗自退；插件 dispose 也按
  pid（tasklist 校验 python 才杀）收窗；DSH 重启先收旧窗再开新窗。
- 交互：拖窗=移动；点一下=摸头（5 连击 happy/playful/laughing/excited/shy）；
  双击=表演（playful+弹跳+转圈+粒子）；**滚轮=无级缩放**（90~420px，右下角锚定，
  尺寸记忆在 `~/.dsh/blob-pet-view.json`）；右键=尺寸预设/图鉴入口/显示隐藏/退出。
- 渲染真源：引擎只跑在 DSH 宿主内（`engine-core.cjs`，node:vm 沙箱），窗是纯显示端，
  经 sidecar `/frames` 取帧。独立窗/本地桥回退/浏览器 --app 小窗模式均已移除（多套引擎
  会各走一条路，曾致点击与画面不一致）；`render-bridge.cjs` 仅保留作无头回归测试用。
- 图鉴（39 态网页）：sidecar `/gallery`，右键菜单直接打开。
- GUI 页面注入默认关；想要页面上也挂一只：`~/.dsh/blob-pet.json` 写 `{"gui": true}`。
- 依赖：本机 Python 3.13 + PySide6（已装）。

## 测试

```bash
node tools/smoke.cjs        # 引擎冒烟：39 状态 + tricks API
node tools/host-test.cjs    # 宿主链路：假 ctx → GUI 路由/sidecar/SSE/token 栅栏
node tools/native-smoke.cjs # 端到端无头回归：engine-core → render-bridge 逐帧 SVG + QtSvg 渲染像素校验
node tools/render-bridge.cjs --bench  # 序列化性能基准（基线约 0.15ms/帧）
```

## ⚠️ 版权边界（务必读）

本仓库**公开留档，但仅供个人学习使用**。`web/grok/` 目录下的几何数据、形状
路径、眼睛多边形与表情数据**提取自 xAI Grok Bot 应用包（app.asar）**，**归
xAI / 相应权利人所有**，不适用本仓库的 MIT 许可（见 LICENSE 双层声明）：

- **仅限个人学习研究**，请勿商用、勿再分发、勿当作原创素材发布；
- 本插件设计为**仅本机使用**，上传 GitHub 只为个人代码留档，**不代表授权公开
  分发**这些提取资产；
- 引擎外壳代码（character.js / pose.js / fx.js 等对提取数据的编排）与本插件的
  `lib/`、`tools/` 为原创，适用 MIT。

若你要公开分发或分享给他人，**必须把 `web/grok/` 整体替换回原创绘制的数据**。
