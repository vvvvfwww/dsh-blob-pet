# dsh-blob-pet · DSH 桌宠

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
| 问你问题 | 气泡「等你回话」（`ask_user_question` 事件只给 label）；`notifying` 状态没接，见下 |
| 等你批准 | `alerting`（**bang 惊叹号 overlay**） |
| 回合完成 | `celebrate` + **burstOnce 粒子爆发** → `proud` → `bored`；连续 3 次触发 **spinOnce 转圈** |
| 请求失败 | `scared` → `confused` → `sad` 三段哀悼 |
| 拖拽 / 松手 | `dragging` / 落下 `bouncing`（**ball 弹跳 overlay**） |
| 点一下摸头 | 5 连击轮换：`happy`→`playful`→`laughing`→`excited`→`shy` + bounceOnce |
| 空闲 90s | 引擎 onboarding 轮换（idle↔8 种表情，每 1200ms，含 wink 随机单眼眨） |
| 空闲 4 / 6 / 12 分钟（90s 空转之后再加 150s / 270s / 630s） | `drowsy` → `sleeping` → `powering-down`（**standby 待机 overlay**） |
| 睡着被叫 | 他真实的 `waking` 起床态（眼 13，800ms）+「啊？叫我？」 |

引擎里能被 `setState()` 显式列出的状态共 **42 个**：`web/grok/tables.js` 的 `GROUPS` 列了
39 个（Lifecycle 7 / Reactions 16 / Agent morphs 3 / Product lifecycle 13；运行期 Reactions 会被
推到 19），`tools/engine-core.cjs`
运行期又注入 `singing` / `dancing` / `giggle` 3 个。本插件映射了其中 38 个，没接的是
`surprised` / `angry` / `curious` / `notifying`。

overlay 侧：`web/grok/fx.js` 定义了 **14 种**（dots / orbit / radar / progress / gather / wave /
send / receive / dock / ball / whirl / pencil / bang / standby），且 **14 种全被用到**——但 `paint()`
只派发其中 12 个绘制器，`ball` / `whirl` 不进 `paint()`，只通过 `extras()` 驱动物理
（弹跳位移 / 旋涡收放）。spin/bounce/burst 三个 trick API 全接入。

## 实现分工

- **形象引擎 = `web/grok/` 下的 8 个模块**：`geometry-data.js`（几何数据：25 套眼睛 /
  18 种身形 / 11 色板）、`math.js`、`tables.js`（`EYE_PLAYLIST` / `EYE_HOLD_MS` /
  `BLINK_MS` 节奏表、`SPRINGS` 弹簧参数、`GROUPS` 状态分组、onboarding 轮换表）、
  `pose.js`、`tricks.js`、`fx.js`（overlay 与粒子）、`eyes.js`（画眼）、
  `character.js`（角色总装 + SVG 序列化）。这 8 个文件是引擎的静态主体，
  运行期还会被补进新状态（见下一条），不是只读的静态拷贝。
- 本插件自己写的代码只有两层：
  - `lib/index.js`：DSH 宿主事件（session/event + assistant-stream）→ SSE `/blob-pet/events`；
    `tapIndex` + `webserver/index-inject` 双通道注入。
  - `web/pet.js`：agent 活动 → 他的状态名的映射表 + 气泡/拖拽/摸头交互。
- `/blob-pet/pet.js` 由宿主把 9 个文件拼成单文档下发（mtime 签名缓存，改任一文件刷新即生效；
  `lib/index.js` 的 `getEngine()` 把 `engine-core.cjs` 与 `web/grok/*.js` 的 mtime 一起算签名，
  所以只改引擎文件也会热重载）。
- 团子对引擎的改动有**两处**：
  - `character.js` 的 `keepBody`（`bodyW = 1`、`wre = 0`）——overlay 状态会把身体缩成粒子环
    （`bodyW = 1 - yl` → scale≈0.14），QtSvg 序列化后粒子不渲染，团子会塌成小黑点。只有
    `tools/engine-core.cjs` 建引擎时显式传 `keepBody: true`；浏览器侧（图鉴页、网页团子）不传，
    保持上游默认 `false`——overlay 特效画在身体之下，靠 `bodyW = 1 - yl` 把身体收掉才露得出来。
    0.9.0 曾把默认值翻成 `true`，结果图鉴里所有特效态都变成纯黑圆盘，0.9.1 改回。
  - `tools/engine-core.cjs` 的**运行期注入**（不改 `web/grok/*.js` 源码）：给 `GROK_TABLES` 的
    `EYE_PLAYLIST` / `EYE_HOLD_MS` / `BLINK_MS` 补 `singing`（眼 2/11/17/19/8）、
    `dancing`（17/21/2/8）、`giggle`（11/2/17）三个状态；给 `GROK_FX.MAP` 补
    `singing → wave`、`dancing → orbit`（复用现成的 overlay，不新增绘制器）；再把这三个名字推进
    `GROK_TABLES.GROUPS` 的 `Reactions` 组（16 → 19，宿主内引擎的状态表；图鉴页是浏览器静态加载
    `tables.js` 的，仍然只列 39 张卡）。
- 想换身形/颜色：网页团子直接右键面板选（见下节）；代码里是 `new GrokCharacter(svg, {shape, color})`，
  可选 `GROK_GEO.shapes` 里 18 种 × `palette` 里 11 色。

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
（`node:vm` 全局隔离——不是安全边界，`tools/engine-core.cjs`），团子窗是纯显示端
（PySide6 + QSvgRenderer）——**没有 node 子进程**，整机只多一个 pythonw
（约 60MB 内存、约 3% 单核）：

```
DSH 宿主（引擎 + 42 态状态机，/frames NDJSON 60fps）──▶ tools/pet-native.py（透明置顶窗）
        ▲ session/event / assistant-stream
        └── DSH 会话真实活动（user/推理/工具/批准/完成/失败）
```

- sidecar 路由：`/frames?k=`（ndjson 帧流，主通道）、`/pet?cmd=pet|show`
  （摸头/表演）、`/cmd`（拖拽/显示隐藏等交互）、`/state`（当前状态）、
  `/gallery`、`/grok/*`（图鉴资源）。
  另有 GUI 注入通道 `/blob-pet/*`（`/blob-pet/pet.js` 单文档、`/blob-pet/events` SSE），仅当 `{"gui": true}` 时启用。
- 帧循环在 `lib/index.js` 的 `ensureEngineLoop()`：`setInterval(…, 16)` 每 16ms 一跳，没有
  `/frames` 订阅者时直接 return、**不调 `engine.frame()`**（所以空闲时不烧 CPU）。
  `engine-core.cjs` 自己没有任何停摆/定时逻辑——它是**拉模式**：谁调 `frame()` 谁推一帧，
  推进与节流都由调用方决定。
- 生命周期：spawn 带 `--parent-pid`，DSH 宿主退出 → 窗自退；插件 dispose 也按
  pid（tasklist 校验 python 才杀）收窗；DSH 重启先收旧窗再开新窗。
- 交互：拖窗=移动；点一下=摸头（5 连击 happy/playful/laughing/excited/shy）；
  双击=表演（playful+弹跳+转圈+粒子）；**滚轮=无级缩放**（90~420px，右下角锚定，
  尺寸记忆在 `~/.dsh/blob-pet-view.json`）；右键=尺寸预设/图鉴入口/显示隐藏/退出。
- 渲染真源：引擎只跑在 DSH 宿主内（`engine-core.cjs`，node:vm 全局隔离、非安全边界），窗是
  纯显示端，经 sidecar `/frames` 取帧。独立窗/本地桥回退/浏览器 --app 小窗模式均已移除（多套引擎
  会各走一条路，曾致点击与画面不一致）。
- 帧协议：`frame()` 返回 `{svg, label, labelMs, state}`（0.9.0 加的 `labelMs` 是气泡剩余毫秒，
  给原生窗做淡出；无气泡为 0）。节拍只有两个地方会设：宿主 `ensureEngineLoop()` 的 16ms 定时器
  （60fps NDJSON），以及独立进程壳 `render-bridge.cjs` 里的 `setInterval(frame, 16)`。后者现在只是
  一层**薄壳**（引擎、状态映射都在 `engine-core.cjs`，薄壳只做 stdin/stdout 的 JSON 行转接），
  留着是为了 `native-smoke.cjs` 的独立进程回归。
- 图鉴（网页按 `web/grok/tables.js` 的 `GROUPS` 列 **39 张状态卡**；`singing`/`dancing`/`giggle`
  是宿主侧运行期注入的，不进图鉴页）：sidecar `/gallery`，右键菜单直接打开。
- GUI 页面注入默认关；想要页面上也挂一只：`~/.dsh/blob-pet.json` 写 `{"gui": true}`。
- 依赖：本机 Python 3.13 + PySide6（已装）。

## 网页团子（GUI 注入）· 右键团子出设置面板

`~/.dsh/blob-pet.json` 里 `{"gui": true}` 时，GUI 右下角也挂一只；除了拖拽/摸头，**右键团子弹面板**：

| 面板项 | 效果 | 持久化键 |
|---|---|---|
| 大小 | 60–200px，滚轮同效 | `dsh-blob-pet-size` |
| 渐变 | 两个取色器（下端色 → 上端色）+ `⇄` 对调 + 7 组预设（墨/石墨/藏青/苔绿/紫檀/赭石/霞） | `dsh-blob-pet-ink` |
| 眼睛微调 | 眼距 20–40 / 左·右·复位 / 眼大小 60–150% / 眼宽 16–24 / 眼高 40–56 / 眼斜角 ±15°（放大时眼距自动 ×√倍数跟着拉开） | `dsh-blob-pet-eye` |
| 形状 | 18 种身形下拉（团子/卵石/豆子/蛋/方圆/药片/胶囊/圆柱/六边/宝石/晶体/楔子/盾牌/圆顶/拱门/云朵/水滴/叶子），走引擎 `setShape()` 弹簧过渡 | `dsh-blob-pet-shape` |
| 主题渐变 | 关掉就是纯色墨 | `dsh-blob-pet-grad` |
| 跟随鼠标 | 眼睛是否跟着指针 | `dsh-blob-pet-follow` |
| 恢复默认 / 藏起来 | 回到 90px + 默认渐变 + 团子身形 / 隐藏团子 | — |

面板项全部与原生桌面窗共用一份外观文件（见下），面板改完不用重启。

- 面板标题右侧是**版本徽标**（`团子设置 v0.9.1`）：浏览器脚本不会自己热更，改完必须 `Ctrl+Shift+R`，
  徽标就是确认加载到哪一版的锚。
- 面板内所有指针事件都 `stopPropagation`：点滑杆/取色器不会触发团子的摸头或拖拽（早期版本会被
  `setPointerCapture` 抢走指针，滑杆只能点不能拖）。
- 渐变被页面 CSS 压掉的问题已兜住：`_paint` 每帧把内联 `fill: url(#…)` 重写一次。
- **眼睛微调**（0.8.7 起）：走的是 `paintEyes()` 自带的 `tune` 参数（`eyes.js:51-52,86-95`），
  直接缩放/旋转**会动的那双眼睛**，所以调完眨眼、眼形轮换、追踪都还在，面板开合也不切模式。
  引擎侧只有一处补丁：`character.js` 的 `paintEyes({...})` 传 `tune: this.eyeTune,
  manualMix: this.eyeTune ? 1 : 0`。滑杆区间是**逐参数实测**出来的窄区间（眼距 20–40 /
  眼大小 60–150% / 眼宽 16–24 / 眼高 40–56 / 眼斜角 ±15°）：引擎 `Hee = min(Hee0*tuneW*tuneS,
  _ee/pulse)` 里 `_ee` 正比于两眼间距，所以 0.8.9 起**放大眼睛时把眼距按 √倍数一起拉开**
  （1.5 倍眼 → 间距 ×1.22，上限 46），上限跟着抬高，眼睛整体变大而不会退化成细线或被裁；
  0.8.5 那条「常开 `blendCustomEyes` 会冻住动画」的坑也别再踩。
- **外观同步（0.8.8 起）**：面板改任何一项都会 `POST /blob-pet/look` 给宿主，宿主写
  `~/.dsh/blob-pet-look.json` 并立刻 `getEngine().cmd({cmd:'look'})` 套到宿主内引擎
  （`lib/index.js` 的 `/blob-pet/look` 路由）。原生窗和网页团子吃的是**同一个宿主内引擎**，
  所以外形天然一致：大小/身形/墨色、渐变开关、眼睛微调都跟着走（原生窗自己的窗口尺寸仍由滚轮在窗上
  单独调，存在 `blob-pet-view.json`）。引擎重建时会先读一次这份文件，改完重启不会回到默认外形。
  无头测试壳 `tools/render-bridge.cjs` 走的是老办法——每秒比对文件 mtime，变了就发
  `{cmd:'look'}`（只为独立进程回归，不影响运行时链路）。

## 测试

```bash
node tools/smoke.cjs        # 引擎冒烟：GROUPS 里 39 个状态 + tricks API
node tools/host-test.cjs    # 宿主链路：假 ctx → GUI 路由/sidecar/SSE/token 栅栏
node tools/native-smoke.cjs # 端到端无头回归：engine-core → render-bridge 逐帧 SVG + QtSvg 渲染像素校验
node tools/render-bridge.cjs --bench  # 序列化性能基准（本机实测约 0.22ms/帧，见下）
```

`tools/native-smoke.cjs` 在本机（Windows + PySide6 6.12）可以完整跑通，五段：`engine-core`
进程内真链路（事件 → 帧，查 `labelMs`/`state`/`dispose()`）→ `render-bridge` 薄壳的行协议 →
QtSvg 逐状态解析并抽像素（每帧必须画出非空内容）→ 离屏 `PetWindow`（滚轮 `angleDelta`/`pixelDelta`
两条路、点击穿透 mask 的开合）→ `pet-native.py` 的 AST 检查。全程 `QT_QPA_PLATFORM=offscreen`
且 `DSH_HOME` 指向临时目录，不弹窗、不动真实配置。找不到 PySide6 时直接失败退出（可用
`BLOB_PET_PYTHON` 指定解释器）。

序列化成本（本机实测，Windows / node v24.20.0 / 这台机器，空闲状态下）：
`node tools/render-bridge.cjs --bench` 报 **0.22–0.23 ms/帧**（含 2.7KB SVG 的 JSON 序列化）；
同一台机器上按 8ms 节拍推进（让弹簧/粒子真的在动）时，`engine-core.frame()` 单帧
**平均 0.61 ms、中位 0.58 ms、p95 1.05 ms**。
注意 `--bench` 那个数是空载紧循环：`Date.now()` 几乎不前进、弹簧不动，测的是"没干活"的
序列化成本，别当基线；机器忙的时候这个数会翻倍，两台机器之间也没有可比性。

## 离线单文件版（不装 DSH 也能看）

```bash
node tools/build-offline.cjs                       # -> dist/gallery-offline.html
node tools/build-offline.cjs D:/somewhere/x.html   # 指定输出路径
```

把 `web/gallery.html` 与 `web/grok/` 的 8 个引擎脚本内联成一个自足的 HTML（约 230 KB），
双击即可打开：39 态全部会动，身形/配色/尺寸/深浅、tricks 按钮、自动巡演都在。
没有任何 `<script src>`、`<link>`、`fetch`，断网、U 盘、换机器都能跑，只需要一个支持
`light-dark()` 与 `color-mix()` 的现代 Chromium。`dist/` 不入库（构建产物）。
