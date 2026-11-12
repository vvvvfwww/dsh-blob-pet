# Changelog

## 0.8.5（2026-11-12）— 面板加「换身形」和「眼睛微调」
- 面板新增「形状」下拉：18 种身形（团子 / 卵石 / 豆子 / 蛋 / 方圆 / 药片 / 胶囊 / 圆柱 /
  六边 / 宝石 / 晶体 / 楔子 / 盾牌 / 圆顶 / 拱门 / 云朵 / 水滴 / 叶子），选项就是几何数据里的 key，
  换形状走引擎的 `setShape()`（弹簧过渡），存 `localStorage['dsh-blob-pet-shape']`。
- 面板新增眼睛微调：眼距（0–150）+ 「左 / 右」切换 + 眼大小（35%–220%）/ 眼宽 / 眼高 / 眼斜角（±45°），
  每只眼单独存，写 `localStorage['dsh-blob-pet-eye']`（JSON `{spacing,left,right}`），
  走引擎的 `setEyeTune()`；「复位」只复位当前选中的那只眼，「恢复默认」把身形和两只眼一起复位。
- 引擎补一处：`character.js` 里眼睛微调原来只在「手动捏住」（`holdMix > 0.002`）时才混入，
  现在改为 `const eyeMix = Math.max(holdMix, this.eyeTune ? 1 : 0)`，没有捏住时也生效。
  默认参数（眼距 35 / 20×50 / 100% / 0°）与原画几乎一致：全画面差异 0.21%（采样 2px 步长）。
- 面板内容变多，加了 `max-height:min(74vh,470px); overflow-y:auto`，面板高 418px、在 700px 视口内完整可见。
- 实测：形状下拉 18 项、选「蛋」后 `bot.shapeName === 'egg'` 且身体 path 变化；眼距 95 / 左眼 190%·宽 34·斜 25°
  只影响左眼，切「右」后右侧单独变、左侧保持；复位右侧后回到 20×50；localStorage 两个键都写入；`errs: []`。
  以 `pre=tablet` 走构造期加载时，身形宽度 297px vs 团子 273px（明显变宽，证明 geo 渲染链路正常）。
- VERSION bump 0.8.4 → 0.8.5。

## 0.8.4（2026-11-12）— 面板里加渐变调色
- 面板新增「渐变」行：两个原生取色器（下端色 → 上端色）+ 一键对调；
  取色器 `input` 事件实时生效，同时写入 `localStorage['dsh-blob-pet-ink']`（JSON `{from,to,angle}`）。
- 新增 7 个预设色板（墨 / 石墨 / 藏青 / 苔绿 / 紫檀 / 赭石 / 霞），点一下整套换色；
  当前生效的那组带描边高亮。选色会自动把「主题渐变」打开。
- `inkFor(scheme)` 改为「用户自定义色优先，没有才用按主题的默认色」：
  `const inkFor = (s) => customInk || themeInk(s)`；「恢复默认」会清掉自定义色回到主题色。
- 面板贴近屏幕顶端时自动翻到团子下方展开（`getBoundingClientRect().top < 8` 判定），不再被裁。
- 实测：点「藏青」后 `<stop>` 的 `stop-color` 变为 `#061021 / #4f7fc4`、`__blobInk().fill` 仍是 `url(#…)`、
  localStorage 写入正确、面板 224×227 在 900×620 视口内完整可见、`errs: []`。
- VERSION bump 0.8.3 → 0.8.4。

## 0.8.3（2026-11-12）— 渐变对比度拉大 + 启动自报版本
- 渐变两端的颜色拉开：#000000 → #5b6070（浅色）/ #0b0c10 → #8f97a2（深色）。
  90px 高的身体上下亮度差从 27.9 提到 **57.2**（0–255 亮度，实测值），肉眼能看清是渐变而不是纯色。
- 启动时气泡自报 `v0.8.3 · 渐变开`（渐变被关过则显示 `渐变关（右键开）`），2.6 秒后消失：
  不用开面板、不用开控制台就能确认浏览器跑的是哪一版、渐变开没开。
- VERSION bump 0.8.2 → 0.8.3。

## 0.8.2（2026-11-12）— 面板显示版本号、滑杆可拖、渐变每帧兜底
- 面板标题右侧加了版本徽标（`团子设置 v0.8.2`）：一眼确认浏览器拿到的是哪一版，
  排查「改了没生效」不用再翻控制台。
- 面板内 pointerdown/pointermove/pointerup/click/wheel 全部 stopPropagation：
  即使外层逻辑有遗漏，点滑杆也不会被 `setPointerCapture` 抢走指针（这正是滑杆能点不能拖的原因）。
  实测：滑杆按下时 root.hasPointerCapture === false、团子没位移、状态不变。
- `_paint` 每帧把内联 `fill: url(#…)` 重写一次（原来只在 setColor/setInkGrad 时写）：
  宿主页面 CSS 抢 fill 也压不掉渐变，实测有 `#blob-pet-root svg path{fill:#26262a}` 覆盖时
  `__blobInk()` 仍返回 `fill: url(#grok-ink-…)`。
- VERSION bump 0.8.1 → 0.8.2。

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
