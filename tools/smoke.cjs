// 冒烟测试：在 node 里用最小 DOM stub 跑 grok 引擎 + 宿主壳的事件映射路径
const fs = require('fs')
const path = require('path')

function mkEl(tag) {
  const el = {
    tag, children: [], style: { setProperty() {}, removeProperty() {} }, attrs: {},
    innerHTML: '', textContent: '', dataset: {},
    setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] },
    removeAttribute(k) { delete this.attrs[k] },
    appendChild(c) { this.children.push(c); return c }, removeChild() {},
    addEventListener() {}, removeEventListener() {}, querySelector() { return null },
    querySelectorAll() { return [] }, setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 } },
    classList: { add() {}, remove() {}, contains() { return false } },
  }
  return el
}
const win = { addEventListener() {}, removeEventListener() {} }
global.window = win
global.document = {
  createElement: mkEl, createElementNS: (ns, t) => mkEl(t),
  documentElement: Object.assign(mkEl('html'), {}),
  body: mkEl('body'), head: mkEl('head'),
  getElementById: () => mkEl('div'),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
}
global.navigator = { maxTouchPoints: 0, userAgent: 'node' }
global.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} })
global.performance = { now: () => Date.now() }
let t = 0
global.requestAnimationFrame = (fn) => { if (t++ < 12) setTimeout(() => fn(Date.now()), 0); return 0 }
global.cancelAnimationFrame = () => {}
global.getComputedStyle = () => ({ backgroundColor: 'rgb(255,255,255)' })
global.sessionStorage = { getItem: () => null, setItem() {} }
global.EventSource = function () { this.close = () => {} }
global.fetch = () => Promise.reject(new Error('no net'))

const E = ['geometry-data.js', 'math.js', 'tables.js', 'pose.js', 'tricks.js', 'fx.js', 'eyes.js', 'character.js']
for (const f of E) {
  const src = fs.readFileSync(path.join('web/grok', f), 'utf8')
  try { (0, eval)(src) } catch (err) { console.error('MODULE FAIL', f, err.message); process.exit(1) }
}
console.log('globals:', ['GROK_GEO', 'GROK_MATH', 'GROK_TABLES', 'GROK_POSE', 'GROK_TRICKS', 'GROK_FX', 'GROK_EYES'].map(k => k + '=' + (win[k] ? 'ok' : 'MISSING')).join(' '))
if (typeof win.GrokCharacter !== 'function') { console.error('GrokCharacter MISSING'); process.exit(1) }

// 构造角色
const svg = mkEl('svg')
const bot = new win.GrokCharacter(svg, { shape: 'blob', color: 'black', scheme: 'light', mode: 'hold', state: 'idle', loginWrap: true, sizePx: 120 })
console.log('constructed. state=', bot.state, 'children=', svg.children.length)

// 逐个切换本次映射用到的全部状态（GROUPS 44 态全覆盖）
const ALL = [
  'sleeping', 'waking', 'idle', 'listening', 'thinking', 'searching', 'working',
  'excited', 'surprised', 'suspicious', 'angry', 'drowsy', 'happy', 'curious', 'confused',
  'bored', 'proud', 'shy', 'sad', 'laughing', 'scared', 'playful', 'celebrate',
  'orbit', 'radar', 'progress',
  'spawning', 'humming', 'loading', 'dictating', 'writing', 'sending', 'receiving',
  'uploading', 'notifying', 'alerting', 'dragging', 'bouncing', 'powering-down',
]
for (const s of ALL) {
  try { bot.setState(s, { resetEyes: false }); if (bot.state !== s) throw new Error('state got ' + bot.state) }
  catch (err) { console.error('STATE FAIL', s, err.message); process.exit(1) }
}
console.log('all', ALL.length, 'states ok')
// tricks API
try { bot.spinOnce(1); bot.bounceOnce(); bot.burstOnce(); bot.setEmphasis(true); bot.setEmphasis(false) }
catch (err) { console.error('TRICKS FAIL', err.message); process.exit(1) }
console.log('tricks api ok')
bot.setMode('onboarding')
console.log('onboarding mode ok, moodN=', bot.moodN)
setTimeout(() => { console.log('SMOKE_DONE'); process.exit(0) }, 300)
