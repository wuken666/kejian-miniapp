const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const pages = ['home', 'students', 'schedule', 'record', 'feedback', 'profile', 'insights']
for (const page of pages) {
  const wxml = fs.readFileSync(path.join(root, `pages/${page}/index.wxml`), 'utf8')
  for (const match of wxml.matchAll(/src="(\/assets\/icons\/[^"{}]+\.png)"/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])), `Missing ${match[1]}`)
  }
}
for (const name of ['home', 'students', 'schedule', 'insights', 'feedback']) {
  for (const tone of ['green', 'muted']) assert.ok(fs.existsSync(path.join(root, `assets/icons/${name}-${tone}.png`)))
}
for (const file of fs.readdirSync(path.join(root, 'assets/icons'))) {
  const data = fs.readFileSync(path.join(root, 'assets/icons', file))
  assert.equal(data.subarray(1, 4).toString(), 'PNG')
  assert.equal(data.readUInt32BE(16), 144)
  assert.equal(data.readUInt32BE(20), 144)
  assert.equal(data[25], 6, `${file} must preserve transparency`)
}
const css = fs.readFileSync(path.join(root, 'styles/icons.wxss'), 'utf8')
assert.match(css, /\.glyph-image\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/)
for (const page of ['home', 'record']) {
  const wxml = fs.readFileSync(path.join(root, `pages/${page}/index.wxml`), 'utf8')
  assert.doesNotMatch(wxml, /截图识别|粘贴文字|手动补充|assist-section/)
}
console.log('PASS Native PNG icons, transparency, navigation assets and removed auxiliary entries')
