# Changelog

## 0.8.1（2026-11-12）— 修面板点击串味、渐变被样式压掉
- 面板上的 pointerdown / pointermove / pointerup 一律早退：点滑杆、点开关不再被当成
  「摸头」或「拖拽捏团子」，团子状态保持不动（实测点击后 state 仍是 idle、无气泡）。
- 渐变改用**内联 style** 也写一份（character.js `_paintInkGrad` / setColor 纯色分支）：
  SVG 的 presentation attribute 会被外部 CSS 压掉，内联样式优先级更高。
  实测有 `#blob-pet-root svg path{fill:#26262a}` 这种覆盖时，渐变仍生效（顶部 60.6 / 底部 32.7）。
- 加自检入口 `window.__blobInk()`：控制台敲一下就能看到 grad / fill / style / size / scheme。
- VERSION bump 0.8.0 → 0.8.1。

## 0.8.0（2026-11-12）— 右键设置面板
- 右键团子弹出设置面板：大小滑杆（60–200px，拖动即时生效并存 localStorage）、主题渐变开/关、
  跟随鼠标开/关、恢复默认、藏起来。
- 开关持久化键：`dsh-blob-pet-grad`、`dsh-blob-pet-follow`；「恢复默认」回 90px + 两个开关都开。
- 交互细节：面板内滚动不缩放团子；右键不再触发拖拽；点面板外或按 Esc 关闭；深浅色沿用
  --bp-ink / --bp-paper（实测深色下 --bp-paper = #232428）。
- 回归：滑杆 180 → 恢复默认 90；关渐变后身体 path 的 fill 由 `url(#…)` 变为纯色、再开回渐变；
  「藏起来」置 display:none；全程无 JS 报错；smoke / native-smoke / host-test 全绿。
- VERSION bump 0.7.0 → 0.8.0。

## 0.7.0（2026-11-12）— 引擎跟进 grok-icon-study web 分支 + 三样加料
- 引擎整体升级到上游 `web` 分支（d764946，15 个提交）：character.js 857→1446 行、
  eyes.js 218→424、pose.js 409→411、tables.js +1、fx.js +1（math/tricks/geometry-data 逐字节未变，
  25 眼 / 18 身形 / 11 色 / 39 状态表原样）。
  新增 16 个公开 API：step / flushPerformance / freezeNow / holdFrame / orbitGaze / parts /
  playback / seekEye / setAutoTricks / setEyeTune / setInkGrad / setManualHold / setManualOffset /
  setPlaylistHold / setPose / setSize；构造项新增 driven（外部时钟、可离线逐帧）、geo/playlist 注入、
  frameHalf / fitBox / scheme。_paint 每帧按 shrink/zoom 写 svg viewBox（overlay 缩放按实际像素收敛），
  eyes.js 新增单眼微调 + 四元数头部投影，pose.js 支持 extra.prev（任意帧 seek 不跳变）。
- 重打 keepBody 补丁（character.js:148 / 1295-1302）：不补则 overlay 状态身体缩成粒子环，
  QtSvg 序列化后塌成小黑点（0.6.0 的坑）。
- pose.js 补回自定义三连 singing / dancing / giggle 的 case（上游没有这三个）。
- 加料① 滚轮调大小：网页端 60–200px，记不住会污染仓库，存 localStorage `dsh-blob-pet-size`；
  原生窗沿用 90–420px + ~/.dsh/blob-pet-view.json。
- 加料② 捏团子：拖拽时按位移喂 setManualOffset（tx/ty 上限 30、spin 上限 26，随尺寸反比缩放），
  松手 setManualHold(false)，偏移由 manualMix 弹簧收回。
- 加料③ 主题渐变：setInkGrad 跟随浅/深色（浅 #0a0b0d→#43464e，深 #101116→#6d7279，angle 0）。
  网页端每 4s 复查主题，原生桥在 scheme 切换时同步；QtSvg 实测顶部亮度 55 / 底部 33，渐变可见。
- 回归：smoke 39 状态全过；native-smoke 154 帧 + QtSvg 三帧非空 + py AST OK；host-test 全绿；
  原生逐帧身体覆盖率 旧 1210–1311 / 新 1214–1308（keepBody 有效，无塌缩）。
- 已知差异：网页端 90px 因 sizePx<120 走 fitBox 分支、不再加 CSS scale(1.04)，比旧版小约 4%；
  原生窗不传 sizePx 走老路径，尺寸与之前一致。
- 备份：升级前的旧引擎留在 .bak-engine-061/（未入库）。VERSION bump 0.6.1 → 0.7.0。

## 0.6.1（2026-11-11）— 彻底移除独立窗 + 引擎创建回归修复
- 移除浏览器 --app 独立小窗（B 套）：删 web/standalone.html、删 lib/index.js 的
  /standalone 路由 + sidecar /events SSE 订阅（sbClients）+ bundleDoc standalone 参数；
  gallery.html 的 ?pet=1 独立小窗分支（93 行）、pet-mode 样式块、pet.js 的 SB（浏览器窗）死分支全清。
  团子只走内嵌 PySide 原生窗（A 套 PySide 桥窗已在 0.6.1 前段移除）。
- **修复 v0.6.0 引入的引擎创建回归**：升级块误写 `sandbox.GROK_TABLES`（undefined），
  而 tables.js/fx.js 把表挂在 window（= engine-core 的 winStub），导致 createEngine 抛
  `TypeError: Cannot read properties of undefined (reading 'EYE_PLAYLIST')`——
  整个 vm 引擎从未创建成功，所有 /cmd、broadcast 事件静默失败（try/catch 吞错）。
  改为写 `winStub.GROK_TABLES/GROK_FX` 后 /cmd dragging/drag-end/pet/show 全过。
  native-smoke（走 render-bridge，win 正确）此前未暴露此 bug。
- host-test.cjs：sidecar /events SSE 断言改为「应 404」（路由已删）。
- VERSION bump lib/index.js 0.5.0 → 0.6.1。

## 0.6.0（2026-11-10）— 团子升级（移植自 grok-icon-study 复刻）
- 新状态三连：singing（唱歌摇摆）/ dancing（跳舞自转）/ giggle（咯咯抖动），
  事件驱动：turn-end 后 40% 概率唱歌或跳舞（约 2.6s），user 来消息后 30% 概率咯咯笑（约 1.9s），
  清醒摸头 25% 概率接咯咯笑；注册走 GROK_TABLES（EYE_PLAYLIST/EYE_HOLD_MS/BLINK_MS），
  引擎核心与回退桥同步（engine-core.cjs / render-bridge.cjs）。
- 修复存量渲染塌缩 bug：所有带 FX overlay 的状态（含原生 thinking）在 QtSvg 显示端缩成
  小黑点——overlay 设计是"身体缩成粒子环、粒子接管画面"，但浏览器粒子序列化后不可见。
  新增 keepBody 选项（character.js）：桌宠两端传 keepBody:true，overlay 激活时身体保持满幅。
  验证：singing/dancing/thinking 主组 scale≈1.0，native-smoke 148 帧全状态回归过，
  bench 0.15ms/帧 与基线持平。
- web/grok/pose.js 同步 singing/dancing/giggle 三个 pose case。

## 0.5.0（2026-11-09）
- 内存优化：引擎从独立 node 子进程迁进 DSH 宿主进程（node:vm 沙箱，tools/engine-core.cjs），
  团子窗变纯显示端——进程树从 2 个（pythonw 90MB + node 76MB）减到 1 个（pythonw 60MB），
  总占用 166MB → 60MB，流畅度不变（8/8 采样）。
- sidecar 新路由：/frames?k=（NDJSON 60fps 帧流，主通道）、/pet?cmd=pet|show（摸头/表演）。
- 无订阅者时引擎循环自动停摆（不烧 CPU）。
- pet-native.py：BLOB_PET_INHOST=1 走 inhost 模式（不 spawn node）；
  --bridge 或无该环境变量回退本地桥（render-bridge.cjs 保留）。
- 60fps + 空几何跳过 + viewBox 扩边（跳起/overlay 不再被裁）+ 滚轮/菜单缩放（90~420px，
  记忆 ~/.dsh/blob-pet-view.json）+ 双击=表演（原"双击隐藏"易丢）。
- 假 DOM 补 remove()（修 fx 粒子回收 TypeError 导致的永久冻结）+ TICK_ERR 自愈泵 + 帧看门狗。

## 0.4.0
- 原生窗替代浏览器 --app 窗；单实例互斥锁；同步收窗。

## 0.3.x
- sidecar + Edge --app 独立窗（已弃用）；图鉴页 gallery.html。

## 0.5.1（2026-11-09 深夜）
- 「点了没反应」终版修复：cmd('pet'/'show') 补 armIdle()（睡着的团子被摸头后 16ms 内被打回
  sleeping 的时序 bug）；窗的模式探测从环境变量改为启动时 GET /state 读 inHost（detached
  spawn 的 env 传递不可靠，曾导致窗跑在 bridge 模式用旧桥引擎）。
- 诊断工具：pet-native.py 鼠标事件插桩（pet-input.log，press/release/pet sent）。
