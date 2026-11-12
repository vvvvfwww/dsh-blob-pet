/**
 * dsh-blob-pet — 前端宿主壳。
 *
 * 形象引擎完全使用 blessonism/grok-icon-study 的复刻实现（web/grok/ 八个文件：
 * geometry-data / math / tables / pose / tricks / fx / eyes / character）。
 * 几何数据、25 套眼睛、18 种身形、表情轮换表、弹簧参数、1200ms 登录轮换节奏
 * 全部来自该仓库，未做任何修改。仅供个人学习使用，素材归 xAI/原仓库权利人所有。
 *
 * 本文件只做三件事（引擎脚本由宿主拼在本文件之前）：
 *   1. 建一个固定右下角的容器并 new GrokCharacter（blob / black / 登录页参数）；
 *   2. 把 DSH 会话事件（SSE）映射到引擎的全部状态面（39 状态 + overlay 特效
 *      + spin/bounce/burst tricks + emphasis + drowsy/sleeping/waking/powering-down 睡眠链）；
 *   3. 拖拽 / 摸头 / 隐藏交互。
 */
(function () {
  if (window.__BLOB_PET_LIVE__) return
  window.__BLOB_PET_LIVE__ = true

  const NS = 'http://www.w3.org/2000/svg'

  // ————— 尺寸：滚轮缩放，跟桌面窗一样记住上次 —————
  const SIZE_KEY = 'dsh-blob-pet-size'
  const SIZE_MIN = 60
  const SIZE_MAX = 200
  function readSize() {
    try {
      const n = Number(localStorage.getItem(SIZE_KEY))
      if (Number.isFinite(n) && n > 0) return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n)))
    } catch {}
    return 90
  }
  let sizePx = readSize()
  const PET_BUILD = '0.8.2'   // 面板里显示，用来确认浏览器拿到的是哪一版

  // ————— 样式与容器（GUI 页注入模式） —————
  const style = document.createElement('style')
  style.textContent = `
  #blob-pet-root{position:fixed;right:26px;bottom:22px;z-index:2147483000;cursor:grab;
    user-select:none;-webkit-user-select:none;touch-action:none;text-align:center}
  #bp-label{display:block;font:600 11px/1.4 system-ui,sans-serif;color:var(--bp-ink,#17181c);
    background:var(--bp-paper,#fff);border:1px solid rgba(128,128,128,.35);padding:3px 9px;
    border-radius:10px;white-space:nowrap;opacity:0;transition:opacity .25s;pointer-events:none;
    margin:0 auto 4px auto;width:max-content}
  #bp-label.bp-on{opacity:.96}
  #bp-stage{display:inline-block;position:relative}
  #bp-stage svg{display:block}
  #bp-hide{position:absolute;top:-6px;right:-10px;width:20px;height:20px;border-radius:50%;border:none;
    background:transparent;color:var(--bp-ink,#17181c);opacity:0;font-size:13px;line-height:1;cursor:pointer;z-index:1}
  #blob-pet-root:hover #bp-hide{opacity:.55}
  #bp-menu{position:absolute;right:-4px;bottom:calc(100% + 10px);width:200px;display:none;
    background:var(--bp-paper,#fff);color:var(--bp-ink,#17181c);border:1px solid rgba(128,128,128,.35);
    border-radius:12px;padding:10px 11px;box-shadow:0 10px 28px rgba(0,0,0,.18);
    font:12px/1.5 system-ui,sans-serif;text-align:left;cursor:default}
  #bp-menu.bp-open{display:block}
  #bp-menu .bp-title{font-weight:700;font-size:11px;letter-spacing:.06em;opacity:.55;margin:0 0 8px}
  #bp-menu .bp-title em{font-style:normal;font-weight:400;opacity:.8;letter-spacing:0}
  #bp-menu .bp-row{display:flex;align-items:center;gap:8px;margin:6px 0}
  #bp-menu .bp-row>span{flex:0 0 56px;opacity:.8}
  #bp-menu input[type=range]{flex:1;min-width:0;accent-color:var(--bp-ink,#17181c)}
  #bp-menu .bp-row>b{flex:0 0 36px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  #bp-menu .bp-tog{margin-left:auto;min-width:46px;padding:2px 10px;border-radius:999px;
    border:1px solid rgba(128,128,128,.45);background:var(--bp-ink,#17181c);color:var(--bp-paper,#fff);
    font:inherit;cursor:pointer}
  #bp-menu .bp-tog.bp-off{background:transparent;color:var(--bp-ink,#17181c);opacity:.55}
  #bp-menu .bp-actions{justify-content:space-between;margin-top:10px}
  #bp-menu .bp-btn{padding:3px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.45);
    background:transparent;color:inherit;font:inherit;cursor:pointer}
  #bp-menu .bp-btn:hover{border-color:var(--bp-ink,#17181c)}
  `
  document.head.appendChild(style)

  let box, label, svg, hide
  box = document.createElement('div')
  box.id = 'blob-pet-root'
  label = document.createElement('div')
  label.id = 'bp-label'
  const stage = document.createElement('div')
  stage.id = 'bp-stage'
  svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'DSH blob pet')
  stage.appendChild(svg)
  hide = document.createElement('button')
  hide.id = 'bp-hide'
  hide.textContent = '×'
  stage.appendChild(hide)
  box.appendChild(label)
    box.appendChild(stage)
    document.body.appendChild(box)

  // 深色探测：GUI 注入看 body 背景亮度
  function detectScheme() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor
      const n = (bg.match(/\d+(\.\d+)?/g) || [255, 255, 255]).slice(0, 3).map(Number)
      return n.reduce((a, b) => a + b, 0) / 3 < 128 ? 'dark' : 'light'
    } catch { return 'light' }
  }
  function applySchemeVars() {
    const dark = detectScheme() === 'dark'
    box.style.setProperty('--bp-ink', dark ? '#e9eaee' : '#17181c')
    box.style.setProperty('--bp-paper', dark ? '#232428' : '#ffffff')
    return dark ? 'dark' : 'light'
  }

  // ————— 气泡 —————
  let labelTimer = null
  function setLabel(text, holdMs) {
    if (labelTimer) clearTimeout(labelTimer)
    if (!text) { label.classList.remove('bp-on'); return }
    label.textContent = text
    label.classList.add('bp-on')
    if (holdMs) labelTimer = setTimeout(() => label.classList.remove('bp-on'), holdMs)
  }

  // ————— 启动（引擎已由宿主拼在本文件之前） —————
  boot()
  function boot() {
    if (typeof GrokCharacter !== 'function') return
    const scheme = applySchemeVars()
    const bot = new GrokCharacter(svg, {
      // 登录页原参数（见 grok-icon-study README）：black / blob / loginWrap
      shape: 'blob',
      color: 'black',
      scheme,
      mode: 'hold',
      state: 'idle',
      loginWrap: true,
      followPointer: true,   // README：源码默认关，预览默认开——桌宠开
      sizePx,
      onChange(snap) { lastState = snap.state },
    })
    window.__blobBot = bot   // 调试入口
    // 渐变自检：控制台敲 __blobInk() 看当前墨色是不是 url(#渐变)
    window.__blobInk = () => ({ grad: !!bot.inkGrad, fill: bot.body.getAttribute('fill'),
      style: bot.body.style.fill, size: sizePx, scheme: lastScheme })
    let lastState = 'idle'

    // ————— 主题渐变：身体从下方墨色过渡到上方柔光，跟着浅/深色切 —————
    const inkFor = (s) => s === 'dark'
      ? { from: '#101116', to: '#6d7279', angle: 0 }
      : { from: '#0a0b0d', to: '#43464e', angle: 0 }
    // ————— 持久化开关 —————
    const GRAD_KEY = 'dsh-blob-pet-grad'
    const FOLLOW_KEY = 'dsh-blob-pet-follow'
    const readFlag = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : v === '1' } catch { return def } }
    const writeFlag = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0') } catch {} }
    let gradOn = readFlag(GRAD_KEY, true)
    let followOn = readFlag(FOLLOW_KEY, true)
    bot.setFollowPointer(followOn)
    if (gradOn) bot.setInkGrad(inkFor(scheme))

    let lastScheme = scheme
    setInterval(() => {
      const s = applySchemeVars()
      if (s === lastScheme) return
      lastScheme = s
      bot.setColor('black', s)
      bot.setInkGrad(gradOn ? inkFor(s) : null)
    }, 4000)

    // ————— 右键面板：大小 / 主题渐变 / 跟随鼠标 / 恢复默认 / 藏起来 —————
    const menu = document.createElement('div')
    menu.id = 'bp-menu'
    menu.innerHTML = '<div class="bp-title">团子设置<em id="bp-ver"> v' + PET_BUILD + '</em></div>'
      + '<div class="bp-row"><span>大小</span><input id="bp-size" type="range" min="' + SIZE_MIN + '" max="' + SIZE_MAX + '" step="5" value="' + sizePx + '"><b id="bp-size-v">' + sizePx + '</b></div>'
      + '<div class="bp-row"><span>主题渐变</span><button class="bp-tog" data-k="grad" type="button"></button></div>'
      + '<div class="bp-row"><span>跟随鼠标</span><button class="bp-tog" data-k="follow" type="button"></button></div>'
      + '<div class="bp-row bp-actions"><button class="bp-btn" data-a="reset" type="button">恢复默认</button>'
      + '<button class="bp-btn" data-a="hide" type="button">藏起来</button></div>'
    box.appendChild(menu)

    // 面板内的一切事件都到此为止，别再冒泡去触发团子的摸头/拖拽
    ;['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel'].forEach((t) => {
      menu.addEventListener(t, (e) => e.stopPropagation(), false)
    })
    const sizeInput = menu.querySelector('#bp-size')
    const sizeVal = menu.querySelector('#bp-size-v')
    function syncToggles() {
      menu.querySelectorAll('.bp-tog').forEach((b) => {
        const on = b.dataset.k === 'grad' ? gradOn : followOn
        b.textContent = on ? '开' : '关'
        b.classList.toggle('bp-off', !on)
      })
    }
    function openMenu(on) {
      menu.classList.toggle('bp-open', !!on)
      if (on) { sizeInput.value = String(sizePx); sizeVal.textContent = String(sizePx); syncToggles() }
    }
    function closeMenu() { openMenu(false) }
    function setSizeNow(px) {
      sizePx = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(px)))
      bot.setSize(sizePx)
      try { localStorage.setItem(SIZE_KEY, String(sizePx)) } catch {}
      sizeInput.value = String(sizePx)
      sizeVal.textContent = String(sizePx)
    }
    sizeInput.addEventListener('input', () => setSizeNow(Number(sizeInput.value)))
    menu.addEventListener('click', (e) => {
      const tog = e.target.closest('.bp-tog')
      if (tog) {
        if (tog.dataset.k === 'grad') {
          gradOn = !gradOn
          writeFlag(GRAD_KEY, gradOn)
          bot.setInkGrad(gradOn ? inkFor(lastScheme) : null)
        } else {
          followOn = !followOn
          writeFlag(FOLLOW_KEY, followOn)
          bot.setFollowPointer(followOn)
        }
        syncToggles()
        return
      }
      const act = e.target.closest('.bp-btn')
      if (!act) return
      if (act.dataset.a === 'reset') {
        setSizeNow(90)
        gradOn = true; followOn = true
        writeFlag(GRAD_KEY, true); writeFlag(FOLLOW_KEY, true)
        bot.setInkGrad(inkFor(lastScheme)); bot.setFollowPointer(true)
        syncToggles()
      } else if (act.dataset.a === 'hide') {
        closeMenu()
        box.style.display = 'none'
      }
    })
    box.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation()
      openMenu(!menu.classList.contains('bp-open'))
    })
    document.addEventListener('pointerdown', (e) => {
      if (!menu.classList.contains('bp-open')) return
      if (box.contains(e.target)) return
      closeMenu()
    }, true)
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })

    // ————— 滚轮调大小（60–200px）—————
    box.addEventListener('wheel', (e) => {
      if (!e.deltaY) return
      if (menu.contains(e.target)) return        // 面板里滚动不缩放团子
      e.preventDefault()
      setSizeNow(sizePx + (e.deltaY < 0 ? 10 : -10))
      setLabel(`${sizePx}px`, 1200)
    }, { passive: false })

    // ————— 状态映射：agent 活动 → 引擎全部 39 状态面 —————
    // 工具名 → 他的状态 + 中文气泡词。每个都对应他 tables/fx 里的真实条目。
    const T2S = {
      // 干活：working(无特效) / searching(6 眼快速轮换)
      ops_bash: ['working', '跑命令'], bash: ['working', '跑命令'],
      read: ['searching', '读文件'], ops_read_files: ['searching', '读文件'],
      ops_inspect_local_file: ['searching', '读文件'],
      glob: ['searching', '找文件'], ops_glob: ['searching', '找文件'],
      grep: ['searching', '搜代码'], ops_grep: ['searching', '搜代码'],
      web_search: ['searching', '上网查'],
      // 加载/压缩类：loading（whirl 漩涡 overlay）
      web_fetch: ['loading', '读网页'], compress: ['loading', '整理记忆'],
      decompress: ['loading', '翻旧账'], ops_discover_tools: ['loading', '找工具'],
      // 书写类：writing（pencil 铅笔 overlay）
      write: ['writing', '写文件'], edit: ['writing', '改代码'],
      ops_write_file: ['writing', '写文件'], ops_edit_file: ['writing', '改代码'],
      ops_replace: ['writing', '批量改'], ops_copy: ['writing', '复制'],
      ops_move: ['writing', '挪文件'], ops_remove: ['writing', '删文件'],
      // 分身/编排：spawning（gather 汇聚 overlay）
      subagent: ['spawning', '派分身'], subagent_fork: ['spawning', '分身继承'],
      workflow: ['spawning', '编排分身'],
      agent_teams_create: ['spawning', '组团队'],
      agent_teams_approve: ['spawning', '团队开工'],
      agent_teams_add_member: ['spawning', '招队员'],
      // 收/发：sending（send overlay）/ receiving（receive overlay）
      present: ['sending', '交付文件'], send_message: ['sending', '传话'],
      job_output: ['receiving', '收货'], job_list: ['receiving', '查收件'],
      list_agents: ['receiving', '等分身回来'],
      // 雷达/目标：radar
      create_goal: ['radar', '立目标'], update_goal: ['radar', '对目标'],
      get_goal: ['radar', '查目标'],
      schedule_create: ['radar', '定闹钟'], schedule_edit: ['radar', '调闹钟'],
      // 环绕：orbit（orbit overlay 小行星环绕）
      agent_teams_status: ['orbit', '看团队'], agent_teams_send_message: ['sending', '团队喊话'],
      todo_write: ['progress', '排计划'],   // progress：环形进度条 overlay
      // 等你：alerting（bang 惊叹号 overlay）
      ask_user_question: ['alerting', '问你个问题'],
      // 上传/装载：uploading（dock overlay）
      plugin_manager: ['uploading', '装插件'], load_workspace_dependencies: ['uploading', '载依赖'],
      // 念话：dictating（wave overlay）
      skill: ['dictating', '翻技能书'],
    }
    const DEFAULT_TOOL = ['working', '干活']

    let idleTimer = null, drowsyTimer = null, sleepTimer = null, standbyTimer = null
    let napping = 0        // 0 清醒 / 1 drowsy / 2 sleeping / 3 powering-down
    let celebrateCount = 0

    function clearSleepChain() {
      clearTimeout(idleTimer); clearTimeout(drowsyTimer)
      clearTimeout(sleepTimer); clearTimeout(standbyTimer)
    }
    function wakeIfNeeded() {
      if (!napping) return
      const wasDown = napping >= 2
      napping = 0
      clearSleepChain()
      if (wasDown) {                 // 睡醒先走他真实的 waking 状态（眼 13，800ms）
        bot.setMode('hold')
        bot.setState('waking', { resetEyes: false })
        setLabel('啊？叫我？', 1600)
        setTimeout(() => { if (napping === 0 && lastState === 'waking') to('idle') }, 800)
      }
    }
    function to(state, bubble, holdMs) {
      wakeIfNeeded()
      if (napping) return
      bot.setMode('hold')
      // 同状态重复进入：只刷气泡，不重置他的眼表/节拍（stateAt 归零会让 playlist 卡在第一帧）
      if (state !== lastState || bot.mode !== 'hold') bot.setState(state, { resetEyes: false })
      if (bubble) setLabel(bubble, holdMs || 5000)
      armIdle()
    }
    function armIdle() {
      clearSleepChain()
      // 90s：切他自带的 onboarding 轮换（curious/happy/playful/excited/listening/proud/laughing/shy 每 1200ms）
      idleTimer = setTimeout(() => {
        bot.setMode('onboarding')
        bot.setEmphasis(false)
        setLabel('', 0)
        // 240s：犯困 drowsy → 360s sleeping → 720s powering-down（standby 特效）
        drowsyTimer = setTimeout(() => { napping = 1; bot.setMode('hold'); bot.setState('drowsy', { resetEyes: false }) }, 150000)
        sleepTimer = setTimeout(() => { napping = 2; bot.setState('sleeping', { resetEyes: false }); setLabel('zZ', 0) }, 270000)
        standbyTimer = setTimeout(() => { napping = 3; bot.setState('powering-down', { resetEyes: false }); setLabel('', 0) }, 630000)
      }, 90000)
    }

    let lastToolName = null
    function handleMsg(m) {
      switch (m.t) {
        case 'user':
          to('listening', '听到啦', 1800)
          bot.bounceOnce()
          break
        case 'delta':
          if (m.kind === 'reasoning') to('thinking')                 // dots 省略号 overlay
          else { bot.setEmphasis(true); to('dictating', '输出中…', 2500) } // 念话 wave
          break
        case 'tool': {
          const pair = T2S[m.name] || DEFAULT_TOOL
          // 连续同一工具 → 升级为 searching 快速搜眼（同 grep 场景视觉一致）
          let [state, word] = pair
          if (m.name === lastToolName && (state === 'working' || state === 'searching')) state = 'searching'
          bot.setEmphasis(state === 'writing' || state === 'progress')
          to(state, '正在' + word)
          lastToolName = m.name
          break
        }
        case 'tool-end':
          if (m.name === 'subagent' || m.name === 'subagent_fork' || m.name === 'workflow' || m.name === 'list_agents') {
            to('receiving', '分身汇报', 2500)
          } else if (m.error) {
            to('suspicious', '嗯？不对劲', 2000)
          } else bot.setEmphasis(false)
          lastToolName = null
          break
        case 'approval':
          if (m.state === 'asked') to('alerting', '等你批准', 10000)   // bang 惊叹号 overlay
          else to('thinking')
          break
        case 'turn-end': {
          clearSleepChain(); napping = 0
          bot.setMode('hold')
          bot.setEmphasis(true)
          bot.setState('celebrate', { resetEyes: false })
          bot.burstOnce()                                              // 粒子爆发（他 fx 的 particles.burst）
          setLabel('搞定！', 2600)
          // 连续搞定 3 次触发一次转圈 trick
          if ((celebrateCount = (celebrateCount + 1) % 3) === 0) bot.spinOnce(1)
          setTimeout(() => {
            bot.setEmphasis(false)
            if (lastState === 'celebrate') {
              bot.setState('proud', { resetEyes: false })             // 得意一下
              setTimeout(() => { if (lastState === 'proud') { bot.setState('bored', { resetEyes: false }); armIdle() } }, 3500)
            }
          }, 2600)
          break
        }
        case 'attempt-failed':
          clearSleepChain(); napping = 0
          bot.setMode('hold')
          bot.setState('scared', { resetEyes: false })
          setLabel('出错了…', 3500)
          setTimeout(() => { if (lastState === 'scared') bot.setState('confused', { resetEyes: false }) }, 1800)
          setTimeout(() => { if (lastState === 'confused') { bot.setState('sad', { resetEyes: false }) } }, 4200)
          setTimeout(armIdle, 9000)
          break
        case 'hello':
          if (m.status === 'running') to('humming', '接着干', 2500)   // 产品生命周期里的 humming
          else armIdle()
          break
      }
    }

    // ————— 摸头互动：在他 16 个反应状态里随机挑一个正面的 —————
    const PET_MOODS = ['happy', 'playful', 'laughing', 'excited', 'shy']
    let petSeq = 0
    let drag = null
    box.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return                // 右键留给设置面板
      if (menu.contains(e.target)) return        // 面板上的按下不拖团子
      if (e.target === hide) return
      drag = { x: e.clientX, y: e.clientY, moved: false, rect: box.getBoundingClientRect() }
      box.setPointerCapture(e.pointerId)
    })
    box.addEventListener('pointermove', (e) => {
      if (!drag) return
      if (menu.contains(e.target)) return
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
      if (drag.moved) {
        clearSleepChain(); napping = 0
        box.style.right = 'auto'; box.style.bottom = 'auto'
        box.style.left = `${drag.rect.left + dx}px`
        box.style.top = `${drag.rect.top + dy}px`
        bot.setMode('hold')
        bot.setState('dragging', { resetEyes: false })               // 他的拖拽态（3→15→0 眼）
        setLabel('', 0)
        // 捏团子：身体跟手慢半拍（往反方向滞后）+ 略微倾斜，松手由弹簧收回
        const soft = 90 / sizePx
        const cap = (v, m) => Math.max(-m, Math.min(m, v))
        bot.setManualHold(true)
        bot.setManualOffset({
          tx: cap(-dx * 0.35 * soft, 30),
          ty: cap(-dy * 0.35 * soft, 30),
          spin: cap(-dx * 0.7 * soft, 26),
        })
      }
    })
    box.addEventListener('pointerup', (e) => {
      if (menu.contains(e.target)) { drag = null; return }   // 面板上的点击不摸头
      bot.setManualHold(false)   // 松手：捏住的偏移按弹簧收回
      if (drag && !drag.moved) {
        wakeIfNeeded()
        const mood = PET_MOODS[(petSeq++) % PET_MOODS.length]
        bot.setMode('hold')
        bot.setState(mood, { resetEyes: false })
        bot.bounceOnce()
        setLabel({ happy: '嘿嘿', playful: '再玩一次！', laughing: '哈哈哈', excited: '哦哦哦！', shy: '诶…害羞' }[mood], 2400)
        setTimeout(() => { if (lastState === mood) { bot.setState('idle', { resetEyes: false }); armIdle() } }, 3000)
      } else if (drag && drag.moved) {
        bot.setState('bouncing', { resetEyes: false })               // 放下的 ball overlay 弹跳
        setLabel('', 0)
        setTimeout(armIdle, 900)
      }
      drag = null
    })

    // ————— SSE —————
    let es = null, retry = 0
    const eventsUrl = () => '/blob-pet/events'
    function connect() {
      try { es = new EventSource(eventsUrl()) } catch { return }
      es.onmessage = (e) => { try { handleMsg(JSON.parse(e.data)) } catch {} }
      es.onerror = () => {
        es.close()
        setTimeout(connect, Math.min(30000, 1200 * 2 ** retry++))
      }
      es.onopen = () => { retry = 0 }
    }
    connect()
    armIdle()
  }
})()
