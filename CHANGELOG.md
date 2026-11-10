# Changelog

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
