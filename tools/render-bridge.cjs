// native 引擎托管桥：grok 引擎 + 事件→状态映射都在这（与 web/pet.js 同一份表），
// stdout 每 33ms 一行 JSON {svg,label,labelMs,state}，stdin 收事件/命令 JSON 行。
// 协议：
//   stdin → {"ev":{...SSE帧...}} | {"cmd":"pet"} | {"cmd":"scheme","value":"dark|light"} | {"cmd":"look","value":{size,shape,ink,eye}} | {"cmd":"quit"}
//   stdout ← {"svg":"<svg…>","label":"正在跑命令","labelMs":5000,"state":"working"}
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const GROK = (f) => path.join(ROOT, 'web/grok', f)

// ——— 最小 DOM（同 smoke.cjs 风格）———
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

const win = { addEventListener() {}, removeEventListener() {} }
global.window = win
const docEl = mkEl('html'); bindInner(docEl)
const body = mkEl('body'); bindInner(body)
global.document = {
  createElement: (t) => { const e = mkEl(t); bindInner(e); return e },
  createElementNS: (ns, t) => { const e = mkEl(t); bindInner(e); return e },
  documentElement: docEl, body,
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
}
global.navigator = { maxTouchPoints: 0, userAgent: 'node-native' }
global.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} })
global.performance = { now: () => Date.now() }
let rafQ = []
global.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length }
global.cancelAnimationFrame = () => {}
global.getComputedStyle = () => ({ backgroundColor: 'rgb(255,255,255)' })

// ——— SVG 序列化（style 并入 presentation attributes，var() 展开给 Qt）———
// defs 保留（QtSvg 支持 linearGradient/radialGradient/stop）；clipPath 剔除（支持不稳，宁缺勿错）
const DROP_TAGS = new Set(['clipPath'])
function esc(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') }
function resolveOne(s, vars) {
  if (typeof s !== 'string') return s
  let out = s.replace(/light-dark\(([^,()]+),\s*([^()]+)\)/g, (_, a, b) => scheme === 'dark' ? b.trim() : a.trim())
  // 递归展开 var(--x, fallback)：QtSvg 不认 var()，必须彻底解成实值
  for (let guard = 0; guard < 8 && out.includes('var('); guard++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\s*\)/g, (_, k, fb) => {
      if (vars[k] != null && !String(vars[k]).includes('var(')) return vars[k]
      return fb != null ? resolveOne(fb, vars) : 'none'
    })
  }
  // CSS 渐变 QtSvg 不认：取第一个色标当实色
  out = out.replace(/linear-gradient\([^)]*?(#[0-9a-fA-F]{3,8})[^)]*?\)/g, '$1')
  return out
}
function ser(el, vars) {
  if (DROP_TAGS.has(el.tag) || el.tag === 'style') return ''
  if (el.style._map.display === 'none') return ''
  // 空几何（r=0 / 无 d）：引擎占位元素，跳过 —— 既省体积也消 QtSvg 的 "path truncated" 刷屏
  if (el.tag === 'circle' && parseFloat(el.attrs.r || '0') <= 0) return ''
  if (el.tag === 'path' && !el.attrs.d) return ''
  const merged = { ...el.attrs }
  delete merged['clip-path'] // QtSvg 的 clipPath 支持不稳，宁缺勿错
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

// ——— 载入引擎并构造角色 ———
for (const f of ['geometry-data.js', 'math.js', 'tables.js', 'pose.js', 'tricks.js', 'fx.js', 'eyes.js', 'character.js']) {
  ;(0, eval)(fs.readFileSync(GROK(f), 'utf8'))
}
// ——— 升级包（同步 engine-core.cjs 的移植，QtSvg 环境适配）———
const NEW_STATES = {
  singing: { eyes: [2, 11, 17, 19, 8], hold: [1400, 2600], blink: null },
  dancing: { eyes: [17, 21, 2, 8], hold: [1200, 2200], blink: [2000, 4000] },
  giggle: { eyes: [11, 2, 17], hold: [900, 1600], blink: [1800, 3200] },
}
for (const [name, d] of Object.entries(NEW_STATES)) {
  win.GROK_TABLES.EYE_PLAYLIST[name] = d.eyes
  win.GROK_TABLES.EYE_HOLD_MS[name] = d.hold
  win.GROK_TABLES.BLINK_MS[name] = d.blink
}
win.GROK_FX.MAP.singing = 'wave'
win.GROK_FX.MAP.dancing = 'orbit'
for (const grp of win.GROK_TABLES.GROUPS) {
  if (grp.label === 'Reactions') {
    for (const n of Object.keys(NEW_STATES)) if (!grp.states.includes(n)) grp.states.push(n)
  }
}
const svg = mkEl('svg'); bindInner(svg)
let scheme = 'light'
const bot = new win.GrokCharacter(svg, {
  shape: 'blob', color: 'black', scheme, mode: 'hold', state: 'idle',
  loginWrap: true, followPointer: false, reduceMotion: false,
  // QtSvg 无浏览器粒子 overlay：overlay 激活时身体会缩成粒子环比例（小黑点）。
  keepBody: true,
})
// 主题渐变：与网页版同一套（身体从下方墨色过渡到上方柔光）
const inkFor = (sc) => sc === 'dark'
  ? { from: '#101116', to: '#6d7279', angle: 0 }
  : { from: '#0a0b0d', to: '#43464e', angle: 0 }
bot.setInkGrad(inkFor(scheme))

// ——— 外观同步：宿主把 GUI 面板的改动写进 ~/.dsh/blob-pet-look.json，这里轮询文件套用 ———
const LOOK_FILE = process.env.BLOB_PET_LOOK_FILE || path.join(
  process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh'), 'blob-pet-look.json',
)
let lookMtime = -1
function applyLook(v) {
  if (!v || typeof v !== 'object') return
  if (typeof v.size === 'number' && Number.isFinite(v.size)) {
    try { bot.setSize(Math.max(60, Math.min(200, Math.round(v.size)))) } catch {}
  }
  if (typeof v.shape === 'string' && v.shape) { try { bot.setShape(v.shape) } catch {} }
  if (v.grad === false) {
    try { bot.setInkGrad(null) } catch {}          // 关掉渐变 = 纯色墨
  } else if (v.ink && typeof v.ink === 'object' && v.ink.from && v.ink.to) {
    try { bot.setInkGrad({ from: String(v.ink.from), to: String(v.ink.to), angle: Number(v.ink.angle) || 0 }) } catch {}
  } else if (v.grad === true) {
    try { bot.setInkGrad(inkFor(scheme)) } catch {}
  }
  if (v.eye !== undefined) { try { bot.setEyeTune(v.eye || null) } catch {} }
}
function pollLook(force) {
  let mt = 0
  try { mt = fs.statSync(LOOK_FILE).mtimeMs } catch { return }
  if (!force && mt === lookMtime) return
  lookMtime = mt
  let j = null
  try { j = JSON.parse(fs.readFileSync(LOOK_FILE, 'utf8')) } catch { return }
  applyLook(j)
}
pollLook(true)
function vars() {
  const s = svg.style._map || {}
  const raw = { '--fg': s['--fg'] || '#000', '--ink': s['--ink'] || '#fff', '--bg': s['--bg'] || '#fff' }
  // 变量值本身可能含 light-dark()/嵌套 var()，先展开一层
  const self = {}
  for (const k in raw) self[k] = resolveOne(raw[k], self)
  return self
}

// ——— 状态映射：与 web/pet.js 同一份表（工具→引擎态+气泡词）———
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

const S = { mood: 'idle', label: '', labelUntil: 0, napping: 0, lastTool: null, celebrateCount: 0, petSeq: 0, lastEvAt: Date.now(), idleAt: Date.now() }
function setLabel(t, ms) { S.label = t || ''; S.labelUntil = t ? Date.now() + (ms || 5000) : 0 }
function to(state, bubble, holdMs) {
  if (state === 'waking' || state === 'idle' || true) { /* wake handled in ev() */ }
  bot.setMode('hold')
  if (state !== bot.state) bot.setState(state, { resetEyes: false })
  S.mood = state
  if (bubble) setLabel(bubble, holdMs)
  S.idleAt = Date.now()
  S.napping = 0
}
function armIdle() { S.idleAt = Date.now() }
const T = setTimeout
function chain(fn, ms) { return T(fn, ms) }

function ev(m) {
  S.lastEvAt = Date.now()
  switch (m.t) {
    case 'user':
      if (S.napping) { to('waking', '啊？叫我？', 1600); chain(() => { if (bot.state === 'waking') to('idle') }, 800) }
      else to('listening', '听到啦', 1800)
      bot.bounceOnce()
      // 升级包：偶尔来个 giggle（憨笑），30% 概率、每 3 次最多 1 次
      if (Math.random() < 0.3 && (S.giggleSeq = (S.giggleSeq || 0) + 1) % 3 === 1) {
        chain(() => { if (bot.state === 'listening') { bot.setState('giggle', { resetEyes: false }); S.mood = 'giggle' } }, 1900)
        chain(() => { if (bot.state === 'giggle') { bot.setState('idle', { resetEyes: false }); S.mood = 'idle' }; armIdle() }, 3500)
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
      bot.setMode('hold'); bot.setEmphasis(true)
      bot.setState('celebrate', { resetEyes: false }); S.mood = 'celebrate'; S.napping = 0
      bot.burstOnce()
      setLabel('搞定！', 2600)
      if ((S.celebrateCount = (S.celebrateCount + 1) % 3) === 0) bot.spinOnce(1)
      // 升级包：收工庆祝 40% 概率升级成唱歌/跳舞，随后照常回 proud
      if (Math.random() < 0.4) {
        const act = Math.random() < 0.5 ? 'singing' : 'dancing'
        chain(() => {
          if (bot.state === 'celebrate') {
            bot.setState(act, { resetEyes: false }); S.mood = act
            setLabel(act === 'singing' ? '啦啦啦~' : '扭一个！', 3000)
            chain(() => { if (bot.state === act) { bot.setState('proud', { resetEyes: false }); S.mood = 'proud'; armIdle() } }, 3000)
          }
        }, 2600)
      } else chain(() => {
        bot.setEmphasis(false)
        if (bot.state === 'celebrate') {
          bot.setState('proud', { resetEyes: false }); S.mood = 'proud'
          chain(() => { if (bot.state === 'proud') { bot.setState('bored', { resetEyes: false }); S.mood = 'bored'; armIdle() } }, 3500)
        }
      }, 2600)
      break
    case 'attempt-failed':
      bot.setMode('hold'); S.napping = 0
      bot.setState('scared', { resetEyes: false }); S.mood = 'scared'
      setLabel('出错了…', 3500)
      chain(() => { if (bot.state === 'scared') { bot.setState('confused', { resetEyes: false }); S.mood = 'confused' } }, 1800)
      chain(() => { if (bot.state === 'confused') { bot.setState('sad', { resetEyes: false }); S.mood = 'sad' } }, 4200)
      chain(armIdle, 9000)
      break
    case 'hello':
      if (m.status === 'running') to('humming', '接着干', 2500)
      else armIdle()
      break
  }
}

function cmd(c) {
  if (c.cmd === 'pet') {
    const mood = PET_MOODS[(S.petSeq++) % PET_MOODS.length]
    bot.setMode('hold'); bot.setState(mood, { resetEyes: false }); S.mood = mood; S.napping = 0
    armIdle()   // 摸头=叫醒：重置空闲计时，否则 sleepTick 下一帧把它按回睡觉
    bot.bounceOnce()
    setLabel(PET_WORDS[mood], 2400)
    // 升级包：摸头 25% 概率升级成 giggle 小憨笑收尾
    if (Math.random() < 0.25) {
      chain(() => { if (bot.state === mood) { bot.setState('giggle', { resetEyes: false }); S.mood = 'giggle' } }, 2200)
    }
    chain(() => { if (bot.state === mood) { bot.setState('idle', { resetEyes: false }); S.mood = 'idle'; armIdle() } }, 3000)
  } else if (c.cmd === 'show') {
    // 双击窗：表演一套（弹跳+转圈+粒子），窗永远留在屏上
    bot.setMode('hold'); S.napping = 0; armIdle()
    bot.setState('playful', { resetEyes: false }); S.mood = 'playful'
    bot.bounceOnce()
    chain(() => { bot.spinOnce(1) }, 350)
    chain(() => { bot.burstOnce() }, 900)
    setLabel('在的在的', 2200)
    chain(() => { if (bot.state === 'playful') { bot.setState('idle', { resetEyes: false }); S.mood = 'idle'; armIdle() } }, 2600)
  } else if (c.cmd === 'scheme' && c.value !== scheme) {
    scheme = c.value
    bot.setColor(bot.colorId, scheme)
    bot.setInkGrad(inkFor(scheme))
  } else if (c.cmd === 'look') {
    let v = c.value
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch { v = null } }
    applyLook(v)
  }
}

// ——— 空闲链：90s onboarding 轮换 → 240s drowsy → 360s sleeping → 720s powering-down ———
function sleepTick(now) {
  if (S.napping >= 4) return
  const idleFor = now - S.idleAt
  if (S.napping === 0 && idleFor > 720000) { S.napping = 3; bot.setMode('hold'); bot.setState('powering-down', { resetEyes: false }); setLabel('', 0) }
  else if (S.napping === 0 && idleFor > 360000) { S.napping = 2; bot.setMode('hold'); bot.setState('sleeping', { resetEyes: false }); setLabel('zZ', 0) }
  else if (S.napping === 0 && idleFor > 240000) { S.napping = 1; bot.setMode('hold'); bot.setState('drowsy', { resetEyes: false }) }
  else if (S.napping === 0 && idleFor > 90000 && bot.mode !== 'onboarding') bot.setMode('onboarding')
}

// ——— 主循环：30fps 泵 rAF + 出帧 ———
let out = process.stdout
let lookCheckedAt = 0
function frame() {
  const now = Date.now()
  if (now - lookCheckedAt > 1000) { lookCheckedAt = now; try { pollLook(false) } catch {} }
  sleepTick(now)
  if (S.label && now > S.labelUntil) { S.label = '' }
  const q = rafQ; rafQ = []
  for (const fn of q) {
    try { fn(now) } catch (err) {
      // 引擎 _tick 抛错 = rAF 链断裂 = 画面永久冻结。记录并重新泵帧，让下一帧把 _tick 接回来。
      process.stderr.write('TICK_ERR ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err) + '\n')
      if (bot._raf !== undefined) { try { rafQ.push((t) => bot._tick(t)) } catch {} }
    }
  }
  const inner = svg.children.map((c) => ser(c, vars())).join('')
  const vbRaw = svg.getAttribute('viewBox') || '-15 -15 259 259'
  const [vx, vy, vw, vh] = vbRaw.split(/[\s,]+/).map(Number)
  // 扩边：跳起/粒子/头顶 overlay 会越出原 viewBox，QtSvg 按框裁切 → 上缘留 70px、左右各 45
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx - 45} ${vy - 70} ${vw + 90} ${vh + 95}">${inner}</svg>`
  out.write(JSON.stringify({ svg: doc, label: S.label, state: bot.state }) + '\n')
}

// stdin 事件循环
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.cmd === 'quit') { process.exit(0) }
    try { if (j.ev) ev(j.ev); else if (j.cmd) cmd(j) } catch (err) { process.stderr.write('bridge err: ' + err.message + '\n') }
  }
})
process.stdin.on('end', () => process.exit(0))

setInterval(frame, 16)   // 60fps：弹簧动画在 30fps 下肉眼发涩
frame()

if (process.argv.includes('--bench')) {
  const real = out.write
  let last = ''
  out.write = (x) => { last = x; return true }
  const N = 120
  const s = Date.now()
  for (let i = 0; i < N; i++) frame()
  const msPerFrame = (Date.now() - s) / N
  out.write = real
  real.call(out, JSON.stringify({ bench: true, msPerFrame, svgLen: JSON.parse(last).svg.length }) + '\n')
  process.exit(0)
}
