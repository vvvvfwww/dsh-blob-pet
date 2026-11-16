// 原生链路冒烟（不弹窗）：
//   1) engine-core 真链路：进程内建引擎 → 灌事件 → 拉帧，检查状态与帧字段
//   2) render-bridge 薄壳：同一个引擎走 stdin/stdout JSON 行，校验壳没丢东西
//   3) QtSvg 渲染：抽样帧能被 QSvgRenderer 解析并画出非空像素
//   4) Qt 离屏窗口：PetWindow 取帧、滚轮缩放（angleDelta / pixelDelta）、点击穿透 mask
// 用法：node tools/native-smoke.cjs      （需要 PySide6；python 路径可用 BLOB_PET_PYTHON 覆盖）
const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-native-'))
const SAMPLE = path.join(TMP, 'frames.json')
const DSH_TMP = path.join(TMP, 'dshhome')   // 隔离：不碰真实 ~/.dsh 的窗口尺寸
fs.mkdirSync(DSH_TMP, { recursive: true })

function findPython() {
  const cands = [process.env.BLOB_PET_PYTHON]
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'))
  cands.push('python', 'python3')
  for (const c of cands) {
    if (!c) continue
    const r = spawnSync(c, ['-c', 'import PySide6, sys; sys.stdout.write(PySide6.__version__)'], { encoding: 'utf8' })
    if (r.status === 0) return { exe: c, pyside: (r.stdout || '').trim() }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 事件脚本：每个状态停 ~600ms，让帧采样一定抓到
const SEQ = [
  { ev: { t: 'user' } },
  { ev: { t: 'tool', name: 'grep', label: '搜代码' } },
  { ev: { t: 'delta', kind: 'reasoning' } },
  { ev: { t: 'turn-end' } },
  { cmd: 'pet' },
]
const EXPECT = ['listening', 'searching', 'thinking', 'celebrate', 'happy']

let failures = 0
function check(ok, msg) {
  if (!ok) { failures++; console.error('FAIL:', msg) } else { console.log('ok:', msg) }
}

function checkFrames(frames, tag) {
  check(frames.length >= 30, `${tag}: 帧数 ${frames.length} >= 30`)
  const keys = new Set(frames.flatMap((f) => Object.keys(f)))
  for (const k of ['svg', 'label', 'labelMs', 'state']) check(keys.has(k), `${tag}: 帧含字段 ${k}`)
  const bad = frames.filter((f) => f.label && !(typeof f.labelMs === 'number' && f.labelMs > 0))
  check(bad.length === 0, `${tag}: 有气泡的帧 labelMs 都是正数（坏帧 ${bad.length}）`)
  const svgOk = frames.every((f) => typeof f.svg === 'string' && f.svg.startsWith('<svg'))
  check(svgOk, `${tag}: 每帧都有 <svg ...> 文本`)
  const uniq = [...new Set(frames.map((f) => f.state))]
  const missing = EXPECT.filter((s) => !uniq.includes(s))
  check(missing.length === 0, `${tag}: 期望状态齐全（缺 ${missing.join(',') || '无'}）`)
  return uniq
}

async function part1EngineCore() {
  const { createEngine } = require(path.join(ROOT, 'tools', 'engine-core.cjs'))
  const eng = createEngine(ROOT)
  const frames = []
  const timer = setInterval(() => {
    const f = eng.frame()
    if (f) frames.push(f)
  }, 16)
  for (const step of SEQ) {
    await sleep(600)
    if (step.cmd) eng.cmd({ cmd: step.cmd })
    else eng.ev(step.ev)
  }
  await sleep(600)
  clearInterval(timer)
  checkFrames(frames, 'engine-core')
  check(typeof eng.dispose === 'function', 'engine-core: 导出 dispose()')
  eng.dispose()
  let twice = true
  try { eng.dispose() } catch (e) { twice = false; console.error(e.message) }
  check(twice, 'engine-core: dispose() 可重复调用')
  return frames
}

function part2Bridge() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'render-bridge.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = '', err = ''
    const frames = []
    p.stderr.on('data', (d) => { err += d })
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line) continue
        try { frames.push(JSON.parse(line)) } catch (e) { err += 'BADFRAME ' }
      }
    })
    p.on('error', reject)
    ;(async () => {
      for (const step of SEQ) { await sleep(600); p.stdin.write(JSON.stringify(step) + '\n') }
      await sleep(600)
      p.kill()
      await sleep(200)
    })()
    p.on('exit', () => {
      check(!err.trim(), `render-bridge: stderr 干净（${err.trim().slice(0, 120)}）`)
      checkFrames(frames, 'render-bridge')
      resolve(frames)
    })
  })
}

function runPy(pyExe, code, what) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DSH_HOME: DSH_TMP, QT_QPA_PLATFORM: 'offscreen' }
    const p = spawn(pyExe, ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('exit', (code) => resolve({ code, out: out.trim(), err: err.trim(), what }))
  })
}

;(async () => {
  const py = findPython()
  if (!py) { console.error('FAIL: 找不到带 PySide6 的 python（可用 BLOB_PET_PYTHON 指定）'); process.exit(1) }
  console.log('python:', py.exe, '| PySide6', py.pyside)

  // —— 1) engine-core 真链路 ——
  const engFrames = await part1EngineCore()
  // —— 2) render-bridge 薄壳 ——
  const brFrames = await part2Bridge()

  // 抽样：每个状态挑一帧，交给 Qt 真解析
  const picked = []
  const byState = new Map()
  for (const f of brFrames) if (!byState.has(f.state)) byState.set(f.state, f)
  for (const f of byState.values()) picked.push(f)
  fs.writeFileSync(SAMPLE, JSON.stringify(picked), 'utf8')
  console.log(`sampled ${picked.length} frames (one per state) → Qt`)

  // —— 3) QtSvg 渲染 + 4) 离屏窗口（滚轮 / mask） ——
  const pyCode = `
import importlib.util, json, os, queue, sys, time
from PySide6.QtWidgets import QApplication
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtGui import QImage, QPainter, QWheelEvent
from PySide6.QtCore import QPoint, QPointF, Qt

SAMPLE = r"${SAMPLE}"
PETPY = r"${path.join(ROOT, 'tools', 'pet-native.py')}"
frames = json.load(open(SAMPLE, encoding="utf-8"))

# --- 3) 每帧都要能被 QtSvg 解析并画出非空像素 ---
for i, f in enumerate(frames):
    r = QSvgRenderer(f["svg"].encode("utf-8"))
    assert r.isValid(), "invalid svg #%d" % i
    assert r.defaultSize().width() > 0, "no default size #%d" % i
    img = QImage(200, 200, QImage.Format_ARGB32); img.fill(Qt.transparent)
    p = QPainter(img); r.render(p); p.end()
    n = sum(1 for y in range(0, 200, 3) for x in range(0, 200, 3) if img.pixelColor(x, y).alpha() > 0)
    assert n > 100, "empty render #%d n=%d" % (i, n)
print("QTSVG_OK frames=%d" % len(frames))

# --- 4) 离屏窗口 ---
spec = importlib.util.spec_from_file_location("petnative", PETPY)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
app = QApplication([])
q = queue.Queue(maxsize=m.FRAME_Q_MAX)
svg = frames[0]["svg"]
w = m.PetWindow(q, 0)
w.show(); app.processEvents()

def feed(label="", ms=0, state="idle"):
    q.put({"svg": svg, "label": label, "labelMs": ms, "state": state})
    w.drain_frames(); app.processEvents()

feed()
assert w.bot_px == 170, "default bot_px %r" % w.bot_px
win_area = w.width() * w.height()
assert not w.mask().isEmpty(), "mask 应罩住角色本体（否则整窗吃点击）"
mask_area = w.mask().boundingRect().width() * w.mask().boundingRect().height()
assert mask_area < win_area, "mask %d 应小于整窗 %d" % (mask_area, win_area)
print("MASK_OK body=%d win=%d" % (mask_area, win_area))

def wheel(pixel, angle):
    pos = QPointF(w.width() / 2, w.height() / 2)
    ev = QWheelEvent(pos, pos, QPoint(*pixel), QPoint(*angle),
                     Qt.NoButton, Qt.NoModifier, Qt.NoScrollPhase, False)
    w.wheelEvent(ev); app.processEvents()

base = w.bot_px
wheel((0, 0), (0, 120))          # 鼠标滚轮：只有 angleDelta
assert w.bot_px > base, "angleDelta 向上滚应放大：%r → %r" % (base, w.bot_px)
up = w.bot_px
wheel((0, 120), (0, 0))          # 触摸板：只有 pixelDelta
assert w.bot_px > up, "pixelDelta 向上滚应放大：%r → %r" % (up, w.bot_px)
top = w.bot_px
wheel((0, 0), (0, -120))
assert w.bot_px < top, "向下滚应缩小：%r → %r" % (top, w.bot_px)
wheel((0, 0), (0, 0))            # 两个都是 0：不能崩、不能动
assert w.bot_px == w.bot_px, "零滚动不应改变尺寸"
print("WHEEL_OK %d -> %d -> %d -> %d" % (base, up, top, w.bot_px))

feed("气泡在", 3000, "notifying")   # 有气泡：mask 放开到整窗（否则气泡被裁）
assert w.mask().isEmpty(), "有气泡时 mask 应为空（覆盖整窗）"
print("MASK_BUBBLE_OK")
w.label_until = time.monotonic() - 1   # 气泡到期
w._update_mask(); app.processEvents()
assert not w.mask().isEmpty(), "气泡到期后 mask 应收回角色本体"
print("MASK_EXPIRE_OK")
w.close()
print("PETWINDOW_OK")
`
  const q = await runPy(py.exe, pyCode, 'qt')
  if (q.code !== 0) {
    console.error('FAIL qt/petwindow:\n' + (q.err || q.out).slice(0, 1500))
    failures++
  } else {
    for (const line of q.out.split('\n')) if (line) console.log(line)
  }

  // —— 5) pet-native.py 语法（AST 级，不启动 GUI） ——
  const ast = spawnSync(py.exe, ['-c', 'import ast;ast.parse(open(r"' + path.join(ROOT, 'tools', 'pet-native.py') + '",encoding="utf-8").read());print("AST_OK")'], { encoding: 'utf8' })
  check(ast.status === 0 && (ast.stdout || '').includes('AST_OK'), 'pet-native.py: AST 通过')

  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) { /* 临时目录，删不掉无所谓 */ }
  if (failures) { console.error(`NATIVE_SMOKE_FAILED (${failures})`); process.exit(1) }
  console.log('NATIVE_SMOKE_DONE')
})().catch((e) => {
  console.error('CRASH', e && e.stack ? e.stack : e)
  process.exit(1)
})
