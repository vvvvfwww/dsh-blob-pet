// dsh-blob-pet | Node >= 16 | CommonJS
// Build: node tools/build-offline.cjs [outFile]
// Run:   node tools/build-offline.cjs
// Deps:  none
//
// 把 web/gallery.html + web/grok/*.js 打成一个自足的 HTML：
// 双击就能看 39 态动画，不需要 node、不需要 DSH、不需要联网，
// 也没有任何 <link>/<script src>/fetch —— 整个文件就是全部。

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const webDir = path.join(root, 'web')
const out = process.argv[2] || path.join(root, 'dist', 'gallery-offline.html')

const SRC_RE = /^(\s*)<script src="([^"]+)"><\/script>\s*$/gm

const html = fs.readFileSync(path.join(webDir, 'gallery.html'), 'utf8')

let inlined = 0
const result = html.replace(SRC_RE, (m, indent, rel) => {
  const file = path.join(webDir, rel)
  const code = fs.readFileSync(file, 'utf8')
  if (code.includes('</script')) {
    throw new Error(`${rel} 含有 </script> 字面量，不能直接内联`)
  }
  inlined++
  // 每个文件单独一个 <script>，保持各自的顶层作用域与执行顺序
  return `${indent}<script>\n/* ===== web/${rel} ===== */\n${code}\n</script>`
})

if (!inlined) throw new Error('没找到任何 <script src="...">，gallery.html 结构变了？')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const stamp = new Date().toISOString().slice(0, 10)
const banner = `<!-- dsh-blob-pet 动作图鉴 · 离线单文件版 (built ${stamp}) -->
<!-- 全部 JS 已内联；双击即可打开，无外部依赖、无网络请求。 -->
`
const finalHtml = banner + result
  .replace(/<\/title>/, `</title>\n<!-- offline single-file build ${stamp} -->`)
  // 离线版没有"本机 DSH 端口"这回事，失败提示不能留着误导
  .replace('引擎加载失败：请用本机 DSH 端口打开本页', '引擎加载失败：这个离线文件可能被截断了，重新生成一份')
  .replace('<footer>dsh-blob-pet</footer>',
    `<footer>dsh-blob-pet v${pkg.version} · 离线单文件 · built ${stamp}</footer>`)

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, finalHtml, 'utf8')

const kb = (Buffer.byteLength(finalHtml, 'utf8') / 1024).toFixed(1)
console.log(`inlined ${inlined} script(s) -> ${out} (${kb} KB)`)
