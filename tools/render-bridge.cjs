// native 引擎托管桥（CLI 薄壳）：引擎本体只有一份 —— tools/engine-core.cjs。
// 宿主内（lib/index.js）与 native-smoke 跑的是同一份状态机，这里只保留「进程 + 行协议」。
// 协议：
//   stdin → {"ev":{...SSE帧...}} | {"cmd":"pet"} | {"cmd":"show"} | {"cmd":"scheme","value":"dark|light"}
//           | {"cmd":"look","value":{size,shape,ink,eye}} | {"cmd":"pointer","nx":0,"ny":0} | {"cmd":"quit"}
//   stdout ← {"svg":"<svg…>","label":"正在跑命令","labelMs":5000,"state":"working"}（每 16ms 一行）
//   --bench → 输出 {"bench":true,msPerFrame,svgLen} 后退出
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createEngine } = require('./engine-core.cjs')

const ROOT = path.resolve(__dirname, '..')
const engine = createEngine(ROOT)

// ——— 外观同步：宿主把 GUI 面板的改动写进 ~/.dsh/blob-pet-look.json，这里轮询文件套用 ———
// 套用逻辑在引擎的 cmd({cmd:'look'}) 里（engine-core 的 applyLook），这里不再复制第二份
const LOOK_FILE = process.env.BLOB_PET_LOOK_FILE || path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'blob-pet-look.json',
)
let lookMtime = -1
function pollLook(force) {
  let mt = 0
  try { mt = fs.statSync(LOOK_FILE).mtimeMs } catch { return }
  if (!force && mt === lookMtime) return
  lookMtime = mt
  let j = null
  try { j = JSON.parse(fs.readFileSync(LOOK_FILE, 'utf8')) } catch { return }
  try { engine.cmd({ cmd: 'look', value: j }) } catch {}
}
pollLook(true)

// ——— 主循环：16ms 出帧（60fps：弹簧动画在 30fps 下肉眼发涩）———
const out = process.stdout
let lookCheckedAt = 0
function frame() {
  const now = Date.now()
  if (now - lookCheckedAt > 1000) { lookCheckedAt = now; try { pollLook(false) } catch {} }
  out.write(JSON.stringify(engine.frame()) + '\n')
}

// ——— 基准模式：只报 serialize 成本，不打帧（stdout 干净，方便被脚本解析）———
if (process.argv.includes('--bench')) {
  const N = 120
  let svgLen = 0
  const s = Date.now()
  for (let i = 0; i < N; i++) svgLen = engine.frame().svg.length
  const msPerFrame = (Date.now() - s) / N
  engine.dispose()
  out.write(JSON.stringify({ bench: true, msPerFrame, svgLen }) + '\n')
  process.exit(0)
}

// ——— stdin 事件循环 ———
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
    try { if (j.ev) engine.ev(j.ev); else if (j.cmd) engine.cmd(j) } catch (err) {
      process.stderr.write('bridge err: ' + err.message + '\n')
    }
  }
})
process.stdin.on('end', () => process.exit(0))

const ticker = setInterval(frame, 16)
frame()
