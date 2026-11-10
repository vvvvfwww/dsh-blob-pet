/**
 * engine-core.cjs — grok-icon-study 引擎托管核心（两处复用）：
 *   1. DSH 插件宿主进程（lib/index.js）：node:vm 沙箱跑引擎，帧走 sidecar /frames
 *   2. CLI（render-bridge.cjs）：独立进程模式，native-smoke 回归用
 * createEngine(root) → { ev, cmd, frame, state }
 * 引擎源码 web/grok/*.js 原样未改；素材归 xAI/原权利人，仅本机学习。
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ENGINE_ORDER = ['geometry-data.js', 'math.js', 'tables.js', 'pose.js', 'tricks.js', 'fx.js', 'eyes.js', 'character.js']

// ——— 最小假 DOM（含 remove()，fx 粒子回收要用）———
function mkStyle() {
  const s = {}
  return { setProperty(k, v) { s[k] = v }, getPropertyValue(k) { return s[k] || '' }, removeProperty(k) { delete s[k] }, _map: s }
}
function mkEl(tag) {
  return {
    tag, children: [], attrs: {}, style: mkStyle(), textContent: '', _parent: null,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] },
    removeAttribute(k) { delete this.attrs[k] },
    appendChild(c) { c._parent = this; this.children.push(c); return c },
    remove() {
      if (this._parent) {
        const i = this._parent.children.indexOf(this)
        if (i >= 0) this._parent.children.splice(i, 1)
        this._parent = null
      }
    },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 259, height: 259 } },
  }
}
function bindInner(el) {
  let h = ''
  Object.defineProperty(el, 'innerHTML', { get: () => h, set: (v) => { h = v; el.children = [] } })
}

const DROP_TAGS = new Set(['clipPath'])
function esc(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') }

function createEngine(root, opts = {}) {
  let scheme = opts.scheme || 'light'

  function resolveOne(s, vars) {
    if (typeof s !== 'string') return s
    let outv = s.replace(/light-dark\(([^,()]+),\s*([^()]+)\)/g, (_, a, b) => scheme === 'dark' ? b.trim() : a.trim())
    for (let guard = 0; guard < 8 && outv.includes('var('); guard++) {
      outv = outv.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\s*\)/g, (_, k, fb) => {
        if (vars[k] != null && !String(vars[k]).includes('var(')) return vars[k]
        return fb != null ? resolveOne(fb, vars) : 'none'
      })
    }
    outv = outv.replace(/linear-gradient\([^)]*?(#[0-9a-fA-F]{3,8})[^)]*?\)/g, '$1')
    return outv
  }

  function ser(el, vars) {
    if (DROP_TAGS.has(el.tag) || el.tag === 'style') return ''
    if (el.style._map.display === 'none') return ''
    if (el.tag === 'circle' && parseFloat(el.attrs.r || '0') <= 0) return ''
    if (el.tag === 'path' && !el.attrs.d) return ''
    const merged = { ...el.attrs }
    delete merged['clip-path']
    for (const k in el.style._map) {
      const prop = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
      if (['fill', 'stroke', 'opacity', 'visibility', 'transform', 'stroke-width', 'stroke-linecap'].includes(prop)) {
        if (merged[prop] == null) merged[prop] = el.style._map[k]
      }
    }
    for (const k in merged) merged[k] = resolveOne(merged[k], vars)
    let a = ''
    for (const k in merged) a += ` ${k}="${esc(merged[k])}"`
    const kids = el.children.map((c) => ser(c, vars)).join('')
    if (!kids && !['svg', 'g'].includes(el.tag)) return `<${el.tag}${a}/>`
    return `<${el.tag}${a}>${kids}${el.textContent ? esc(el.textContent) : ''}</${el.tag}>`
  }

  // ——— vm 沙箱：不污染宿主全局 ———
  const rafQ = []
  const winStub = { addEventListener() {}, removeEventListener() {} }
  const docEl = mkEl('html'); bindInner(docEl)
  const bodyEl = mkEl('body'); bindInner(bodyEl)
  const sandbox = {
    window: winStub,
    document: {
      createElement: (t) => { const e = mkEl(t); bindInner(e); return e },
      createElementNS: (ns, t) => { const e = mkEl(t); bindInner(e); return e },
      documentElement: docEl, body: bodyEl,
      getElementById: () => null, addEventListener() {}, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
    },
    navigator: { maxTouchPoints: 0, userAgent: 'dsh-blob-pet-host' },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => { rafQ.push(fn); return rafQ.length },
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ backgroundColor: 'rgb(255,255,255)' }),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setInterval, setTimeout, clearTimeout, clearInterval,
  }
  vm.createContext(sandbox)
  for (const f of ENGINE_ORDER) {
    vm.runInContext(fs.readFileSync(path.join(root, 'web/grok', f), 'utf8'), sandbox, { filename: 'grok/' + f })
  }
  const GrokCharacter = winStub.GrokCharacter

  // ——— 升级包（2026-11-10 移植自 grok-ref playground 版，QtSvg 环境适配）———
  // 新状态：singing / dancing / giggle（web/grok/pose.js 已有对应 case）
  // QtSvg 不认 SVG filter → 无发光眼睛；linearGradient 可用 → 渐变身体在 ser() 天然支持
  const NEW_STATES = {
    singing: { eyes: [2, 11, 17, 19, 8], hold: [1400, 2600], blink: null },
    dancing: { eyes: [17, 21, 2, 8], hold: [1200, 2200], blink: [2000, 4000] },
    giggle: { eyes: [11, 2, 17], hold: [900, 1600], blink: [1800, 3200] },
  }
  // 注意：tables.js/fx.js 把表挂在 window（= winStub），不是 vm 的 sandbox 全局。
  // 必须写 winStub.*，写 sandbox.* 会因属性不存在抛 TypeError，导致整个 vm 引擎创建失败。
  for (const [name, d] of Object.entries(NEW_STATES)) {
    winStub.GROK_TABLES.EYE_PLAYLIST[name] = d.eyes
    winStub.GROK_TABLES.EYE_HOLD_MS[name] = d.hold
    winStub.GROK_TABLES.BLINK_MS[name] = d.blink
  }
  // overlay 复用：singing→wave（声波）、dancing→orbit（星环）
  winStub.GROK_FX.MAP.singing = 'wave'
  winStub.GROK_FX.MAP.dancing = 'orbit'
  // Reactions 组补进 GROUPS，图鉴可见
  for (const grp of winStub.GROK_TABLES.GROUPS) {
    if (grp.label === 'Reactions') {
      for (const n of Object.keys(NEW_STATES)) if (!grp.states.includes(n)) grp.states.push(n)
    }
  }

  const svg = mkEl('svg'); bindInner(svg)
  const bot = new GrokCharacter(svg, {
    shape: 'blob', color: 'black', scheme, mode: 'hold', state: 'idle',
    loginWrap: true,
    // 与页面版一致：眼睛跟着鼠标。桌面窗把全局光标位置换算成 svg 局部坐标喂进来。
    followPointer: true,
    reduceMotion: false,
    // QtSvg 桥没有浏览器粒子 overlay：overlay 激活时身体会被缩成粒子环比例
    // （bodyW=1-yl → scale≈0.14 小黑点），粒子本身又被序列化丢弃。锁定身体比例。
    keepBody: true,
  })

  function vars() {
    const s = svg.style._map || {}
    const raw = { '--fg': s['--fg'] || '#000', '--ink': s['--ink'] || '#fff', '--bg': s['--bg'] || '#fff' }
    const self = {}
    for (const k in raw) self[k] = resolveOne(raw[k], self)
    return self
  }

  // ——— 状态映射（工具→引擎态+气泡词）———
  const T2S = {
    ops_bash: ['working', '跑命令'], bash: ['working', '跑命令'],
    read: ['searching', '读文件'], ops_read_files: ['searching', '读文件'], ops_inspect_local_file: ['searching', '读文件'],
    glob: ['searching', '找文件'], ops_glob: ['searching', '找文件'], grep: ['searching', '搜代码'], ops_grep: ['searching', '搜代码'],
    web_search: ['searching', '上网查'],
    web_fetch: ['loading', '读网页'], compress: ['loading', '整理记忆'], decompress: ['loading', '翻旧账'], ops_discover_tools: ['loading', '找工具'],
    write: ['writing', '写文件'], edit: ['writing', '改代码'], ops_write_file: ['writing', '写文件'], ops_edit_file: ['writing', '改代码'],
    ops_replace: ['writing', '批量改'], ops_copy: ['writing', '复制'], ops_move: ['writing', '挪文件'], ops_remove: ['writing', '删文件'],
    subagent: ['spawning', '派分身'], subagent_fork: ['spawning', '分身继承'], workflow: ['spawning', '编排分身'],
    agent_teams_create: ['spawning', '组团队'], agent_teams_approve: ['spawning', '团队开工'], agent_teams_add_member: ['spawning', '招队员'],
    present: ['sending', '交付文件'], send_message: ['sending', '传话'], agent_teams_send_message: ['sending', '团队喊话'],
    job_output: ['receiving', '收货'], job_list: ['receiving', '查收件'], list_agents: ['receiving', '等分身回来'],
    create_goal: ['radar', '立目标'], update_goal: ['radar', '对目标'], get_goal: ['radar', '查目标'],
    schedule_create: ['radar', '定闹钟'], schedule_edit: ['radar', '调闹钟'],
    agent_teams_status: ['orbit', '看团队'], todo_write: ['progress', '排计划'],
    ask_user_question: ['alerting', '问你个问题'],
    plugin_manager: ['uploading', '装插件'], load_workspace_dependencies: ['uploading', '载依赖'],
    skill: ['dictating', '翻技能书'],
  }
  const PET_MOODS = ['happy', 'playful', 'laughing', 'excited', 'shy']
  const PET_WORDS = { happy: '嘿嘿', playful: '再玩一次！', laughing: '哈哈哈', excited: '哦哦哦！', shy: '诶…害羞' }

  const S = { label: '', labelUntil: 0, napping: 0, lastTool: null, celebrateCount: 0, petSeq: 0, idleAt: Date.now() }
  function setLabel(t, ms) { S.label = t || ''; S.labelUntil = t ? Date.now() + (ms || 5000) : 0 }
  const T = setTimeout
  function wakeIfNeeded() {
    if (!S.napping) return
    const wasDown = S.napping >= 2
    S.napping = 0
    armIdle()
    if (wasDown) {
      // 与页面版同一条睡醒链：先走他真实的 waking 状态（眼 13，800ms）
      bot.setMode('hold')
      bot.setState('waking', { resetEyes: false })
      setLabel('啊？叫我？', 1600)
      chain(() => { if (S.napping === 0 && bot.state === 'waking') to('idle') }, 800)
    }
  }
  function to(state, bubble, holdMs) {
    wakeIfNeeded()
    if (S.napping) return
    bot.setMode('hold')
    if (state !== bot.state) bot.setState(state, { resetEyes: false })
    if (bubble) setLabel(bubble, holdMs)
    S.idleAt = Date.now(); S.napping = 0
  }
  function armIdle() { S.idleAt = Date.now() }
  function chain(fn, ms) { return T(fn, ms) }

  function ev(m) {
    switch (m && m.t) {
      case 'user':
        wakeIfNeeded()
        to('listening', '听到啦', 1800)
        bot.bounceOnce()
        // 升级包：偶尔来个 giggle（憨笑），30% 概率、每 3 次最多 1 次，避免喧宾夺主
        if (Math.random() < 0.3 && (S.giggleSeq = (S.giggleSeq || 0) + 1) % 3 === 1) {
          chain(() => { if (bot.state === 'listening') bot.setState('giggle', { resetEyes: false }) }, 1900)
          chain(() => { if (bot.state === 'giggle') bot.setState('idle', { resetEyes: false }); armIdle() }, 3500)
        }
        break
      case 'delta':
        if (m.kind === 'reasoning') to('thinking')
        else { bot.setEmphasis(true); to('dictating', '输出中…', 2500) }
        break
      case 'tool': {
        const pair = T2S[m.name] || ['working', '干活']
        let [state, word] = pair
        if (m.name === S.lastTool && (state === 'working' || state === 'searching')) state = 'searching'
        bot.setEmphasis(state === 'writing' || state === 'progress')
        to(state, '正在' + word)
        S.lastTool = m.name
        break
      }
      case 'tool-end':
        if (m.name === 'subagent' || m.name === 'subagent_fork' || m.name === 'workflow' || m.name === 'list_agents') to('receiving', '分身汇报', 2500)
        else if (m.error) to('suspicious', '嗯？不对劲', 2000)
        else bot.setEmphasis(false)
        S.lastTool = null
        break
      case 'approval':
        if (m.state === 'asked') to('alerting', '等你批准', 10000)
        else to('thinking')
        break
      case 'turn-end':
        bot.setMode('hold'); bot.setEmphasis(true); S.napping = 0
        bot.setState('celebrate', { resetEyes: false })
        bot.burstOnce()
        setLabel('搞定！', 2600)
        if ((S.celebrateCount = (S.celebrateCount + 1) % 3) === 0) bot.spinOnce(1)
        // 升级包：收工庆祝有 40% 概率升级成唱歌/跳舞（音痴随机挑一个），随后照常回 proud
        if (Math.random() < 0.4) {
          const act = Math.random() < 0.5 ? 'singing' : 'dancing'
          chain(() => {
            if (bot.state === 'celebrate') {
              bot.setState(act, { resetEyes: false })
              setLabel(act === 'singing' ? '啦啦啦~' : '扭一个！', 3000)
              chain(() => { if (bot.state === act) { bot.setState('proud', { resetEyes: false }); armIdle() } }, 3000)
            }
          }, 2600)
        } else chain(() => {
          bot.setEmphasis(false)
          if (bot.state === 'celebrate') {
            bot.setState('proud', { resetEyes: false })
            chain(() => { if (bot.state === 'proud') { bot.setState('bored', { resetEyes: false }); armIdle() } }, 3500)
          }
        }, 2600)
        break
      case 'attempt-failed':
        bot.setMode('hold'); S.napping = 0
        bot.setState('scared', { resetEyes: false })
        setLabel('出错了…', 3500)
        chain(() => { if (bot.state === 'scared') bot.setState('confused', { resetEyes: false }) }, 1800)
        chain(() => { if (bot.state === 'confused') bot.setState('sad', { resetEyes: false }) }, 4200)
        chain(armIdle, 9000)
        break
      case 'hello':
        if (m.status === 'running') to('humming', '接着干', 2500)
        else armIdle()
        break
    }
  }

  function petMood() {
    // 摸头必须能叫醒任何睡眠态：先走 waking（若睡着），再给表情。
    const mood = PET_MOODS[(S.petSeq++) % PET_MOODS.length]
    const wasDown = S.napping >= 2
    S.napping = 0
    armIdle()
    bot.setMode('hold')
    if (wasDown) {
      bot.setState('waking', { resetEyes: true })
      setLabel('啊？叫我？', 900)
      chain(() => { if (bot.state === 'waking') { bot.setState(mood, { resetEyes: true }); bot.bounceOnce(); setLabel(PET_WORDS[mood], 2400) } }, 650)
    } else {
      bot.setState(mood, { resetEyes: true })
      bot.bounceOnce()
      setLabel(PET_WORDS[mood], 2400)
      // 升级包：清醒摸头 25% 概率升级成 giggle 小憨笑收尾
      if (Math.random() < 0.25) {
        chain(() => { if (bot.state === mood) bot.setState('giggle', { resetEyes: false }) }, 2200)
      }
    }
    chain(() => { if (bot.state === mood) { bot.setState('idle', { resetEyes: false }); armIdle() } }, wasDown ? 3400 : 3000)
  }

  function cmd(c) {
    if (!c) return
    if (c.cmd === 'pet') {
      petMood()
    } else if (c.cmd === 'show') {
      petMood()  // 表演 = 摸头 + 转圈 + 粒子（页面版双击/表演的完整体验）
      chain(() => bot.spinOnce(1), 350)
      chain(() => bot.burstOnce(), 900)
    } else if (c.cmd === 'dragging') {
      // 与页面版一致：拖动时走他的 dragging 态（3→15→0 眼）
      S.napping = 0
      bot.setMode('hold')
      bot.setState('dragging', { resetEyes: false })
      setLabel('', 0)
    } else if (c.cmd === 'drag-end') {
      if (bot.state === 'dragging') {
        // 放下的 ball overlay 弹跳，然后回 idle
        bot.setState('bouncing', { resetEyes: false })
        chain(() => { if (bot.state === 'bouncing') { bot.setState('idle', { resetEyes: false }); armIdle() } }, 900)
      }
      armIdle()
    } else if (c.cmd === 'pointer' && c.nx != null) {
      // 眼睛跟随：nx/ny ∈ [-1,1]，映射到 svg 局部坐标（假 DOM 的 rect 恒为 259×259）
      const cx = 129.5 + Math.max(-1.6, Math.min(1.6, c.nx)) * 129.5
      const cy = 129.5 + Math.max(-1.6, Math.min(1.6, c.ny)) * 129.5
      bot.pointerRaw = { x: cx, y: cy }
    } else if (c.cmd === 'scheme' && c.value !== scheme) {
      scheme = c.value
      bot.setColor(bot.colorId, scheme)
    }
  }

  function sleepTick(now) {
    if (S.napping >= 4) return
    const idleFor = now - S.idleAt
    // 刚被摸头/交互过（3s 保护期）绝不进入睡眠链
    if (idleFor < 3000) { S.napping = 0; return }
    if (S.napping === 0 && idleFor > 720000) { S.napping = 3; bot.setMode('hold'); bot.setState('powering-down', { resetEyes: false }); setLabel('', 0) }
    else if (S.napping === 0 && idleFor > 360000) { S.napping = 2; bot.setMode('hold'); bot.setState('sleeping', { resetEyes: false }); setLabel('zZ', 0) }
    else if (S.napping === 0 && idleFor > 240000) { S.napping = 1; bot.setMode('hold'); bot.setState('drowsy', { resetEyes: false }) }
    else if (S.napping === 0 && idleFor > 90000 && bot.mode !== 'onboarding') bot.setMode('onboarding')
  }

  function frame() {
    const now = Date.now()
    sleepTick(now)
    if (S.label && now > S.labelUntil) S.label = ''
    // 先拷贝再清空：q 与 rafQ 若是同一数组，length=0 会把待执行帧一并清掉，
    // 导致 _tick 只在构造时跑一次、眼睛不跟随指针（pointer 恒 0）。
    const q = rafQ.slice(); rafQ.length = 0
    for (const fn of q) {
      try { fn(now) } catch (err) {
        // 引擎 _tick 抛错 = rAF 链断 = 冻结。记录并重新泵帧自愈。
        try { process.stderr.write('TICK_ERR ' + (err && err.message ? err.message : err) + '\n') } catch {}
        try { rafQ.push((t) => bot._tick(t)) } catch {}
      }
    }
    const inner = svg.children.map((c) => ser(c, vars())).join('')
    const vbRaw = svg.getAttribute('viewBox') || '-15 -15 259 259'
    const p = vbRaw.split(/[\s,]+/).map(Number)
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${p[0] - 45} ${p[1] - 70} ${p[2] + 90} ${p[3] + 95}">${inner}</svg>`
    return { svg: doc, label: S.label, state: bot.state }
  }

  return { ev, cmd, frame, get state() { return bot.state } }
}

module.exports = { createEngine, ENGINE_ORDER }
