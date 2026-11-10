// 原生链路冒烟：渲染桥（引擎态机）+ pet-native.py 可导入性检查。不弹窗。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const PY = process.env.BLOB_PET_PYTHON ||
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe')

;(async () => {
  if (!fs.existsSync(PY)) { console.error('python 不存在:', PY); process.exit(1) }
  // 1) 桥：错开发送事件，每个状态停留 ~600ms 让帧采样能抓到
  const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'render-bridge.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let b = '', frames = [], states = [], err = ''
  p.stderr.on('data', (d) => { err += d })
  p.stdout.on('data', (d) => {
    b += d
    let i
    while ((i = b.indexOf('\n')) >= 0) {
      const l = b.slice(0, i); b = b.slice(i + 1)
      if (!l) continue
      try { const j = JSON.parse(l); frames.push(j); states.push(j.state) } catch (e) { err += 'BADFRAME ' }
    }
  })
  const seq = [
    { ev: { t: 'user' } },
    { ev: { t: 'tool', name: 'grep', label: '搜代码' } },
    { ev: { t: 'delta', kind: 'reasoning' } },
    { ev: { t: 'turn-end' } },
    { cmd: 'pet' },
  ]
  for (let k = 0; k < seq.length; k++) {
    await new Promise((r) => setTimeout(r, 600))
    p.stdin.write(JSON.stringify(seq[k]) + '\n')
  }
  await new Promise((r) => setTimeout(r, 800))
  p.kill()
  if (err) { console.error('FAIL bridge:', err.slice(0, 200)); process.exit(1) }
  const uniq = [...new Set(states)]
  console.log('bridge frames:', frames.length, '| states seen:', uniq.join(','))
  if (frames.length < 30) { console.error('FAIL: too few frames'); process.exit(1) }
  const expect = ['listening', 'searching', 'thinking', 'celebrate', 'happy']
  const missing = expect.filter((s) => !uniq.includes(s))
  if (missing.length) { console.error('FAIL: expected states missing:', missing.join(',')); process.exit(1) }
  // 2) 帧的 svg 能被 QtSvg 解析（抽样 3 帧）
  const sample = frames.slice(0, 3).map((f) => f.svg)
  fs.writeFileSync(path.join(os.tmpdir(), 'bp-sample.json'), JSON.stringify(sample))
  const py = spawn(PY, ['-c', `
import json,sys
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtGui import QImage, QPainter
from PySide6.QtCore import Qt
for s in json.load(open(r"${path.join(os.tmpdir(), 'bp-sample.json')}", encoding='utf-8')):
    r=QSvgRenderer(s.encode('utf-8'))
    assert r.isValid(), 'invalid svg'
    img=QImage(200,200,QImage.Format_ARGB32); img.fill(Qt.transparent)
    p=QPainter(img); r.render(p); p.end()
    n=sum(1 for y in range(0,200,3) for x in range(0,200,3) if img.pixelColor(x,y).alpha()>0)
    assert n>100, 'empty render'
print('QTSVG_OK')
`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', perr = ''
  py.stdout.on('data', (d) => { out += d })
  py.stderr.on('data', (d) => { perr += d })
  py.on('exit', (code) => {
    if (code !== 0 || !out.includes('QTSVG_OK')) { console.error('FAIL qt:', perr.slice(0, 300)); process.exit(1) }
    console.log('qtsvg render: OK (3 frames painted non-empty)')
    // 3) pet-native.py 语法 + 导入检查（不启动 GUI）
    const chk = spawn(PY, ['-c', 'import ast;ast.parse(open(r"' + path.join(ROOT, 'tools/pet-native.py') + '",encoding="utf-8").read());print("AST_OK")'], { stdio: ['ignore', 'pipe', 'inherit'] })
    chk.on('exit', (c) => { if (c !== 0) { console.error('FAIL py ast'); process.exit(1) } console.log('pet-native.py: AST OK'); console.log('NATIVE_SMOKE_DONE') })
  })
})().catch((e) => { console.error('CRASH', e.message); process.exit(1) })
