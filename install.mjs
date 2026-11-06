#!/usr/bin/env node
/**
 * dsh-work-progress —— 跨机器 / 跨账号安装脚本
 * ============================================================================
 * 把本目录挂进目标机器的 DSH profile（默认 desktop）：
 *   1. 在 <profile>/node_modules 建 junction / symlink；
 *   2. 在 profile package.json 的 dependencies 写 file: 绝对路径（带备份）；
 *   3. 在 profile cordis.patch.yml 末尾追加 insert 行（幂等，已存在则跳过）。
 *
 * 用法（在目标机器上）：
 *   node install.mjs                          # 装到 ~/.dsh/profiles/desktop
 *   node install.mjs --profile web            # 装到 web profile
 *   node install.mjs --home D:\\dsh-home       # 自定义 DSH_HOME
 *   node install.mjs --plugin D:\\plugins\\dsh-work-progress --profile desktop
 *
 * 安装后重启应用（或关闭窗口从托盘重开）让 loader 重新加载。
 * 验证：GET http://127.0.0.1:<端口>/work-progress/api/health 应返回 ok:true。
 * ============================================================================
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, symlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_NAME = 'dsh-work-progress'
const ENTRY_ID = 'work-progress'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && typeof process.argv[index + 1] === 'string') return process.argv[index + 1]
  return fallback
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

async function backup(file) {
  if (!existsSync(file)) return null
  const target = `${file}.bak-before-work-progress-${timestamp()}`
  await writeFile(target, await readFile(file))
  return target
}

async function main() {
  const profileName = option('profile', 'desktop')
  const dshHome = resolve(option('home', process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
  const pluginDir = resolve(option('plugin', dirname(fileURLToPath(import.meta.url))))
  const profileDir = join(dshHome, 'profiles', profileName)
  const profilePkg = join(profileDir, 'package.json')
  const patchFile = join(profileDir, 'cordis.patch.yml')

  if (!existsSync(profilePkg)) {
    console.error(`找不到 profile：${profileDir}`)
    console.error('请确认 DSH 已启动过该 profile，或检查 --profile / --home 参数。')
    process.exit(1)
  }
  if (!existsSync(join(pluginDir, 'index.js')) || !existsSync(join(pluginDir, 'client.js'))) {
    console.error(`插件目录不完整：${pluginDir}（需要 index.js / client.js）`)
    process.exit(1)
  }

  // 1) node_modules 软链
  const linkPath = join(profileDir, 'node_modules', PKG_NAME)
  await mkdir(dirname(linkPath), { recursive: true })
  if (existsSync(linkPath)) {
    const current = await realpath(linkPath).catch(() => null)
    if (current !== pluginDir) {
      console.error(`已存在 ${linkPath}，但指向 ${current ?? '未知'}，不是 ${pluginDir}。`)
      console.error('请先手动删除该链接再运行。')
      process.exit(1)
    }
    console.log(`[ok] 软链已存在：${linkPath}`)
  } else {
    await symlink(pluginDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`[ok] 已创建软链：${linkPath} -> ${pluginDir}`)
  }

  // 2) profile package.json 依赖
  const pkgText = await readFile(profilePkg, 'utf8')
  const pkg = JSON.parse(pkgText)
  pkg.dependencies = pkg.dependencies ?? {}
  const spec = `file:${pluginDir.replaceAll('\\', '/')}`
  if (pkg.dependencies[PKG_NAME] !== spec) {
    const previous = pkg.dependencies[PKG_NAME]
    pkg.dependencies[PKG_NAME] = spec
    const saved = await backup(profilePkg)
    const tmp = `${profilePkg}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    await rename(tmp, profilePkg)
    console.log(`[ok] 已写入依赖：${PKG_NAME} = ${spec}${previous === undefined ? '' : `（原为 ${previous}）`}`)
    if (saved !== null) console.log(`     备份：${saved}`)
  } else {
    console.log('[ok] 依赖已是目标路径，跳过')
  }

  // 3) cordis.patch.yml insert（幂等）
  const patchText = existsSync(patchFile) ? await readFile(patchFile, 'utf8') : '[]\n'
  if (new RegExp(`name:\\s*['"]?${PKG_NAME}['"]?`, 'm').test(patchText)) {
    console.log('[ok] cordis.patch.yml 已有本插件 insert，跳过')
  } else {
    const saved = await backup(patchFile)
    const block = [
      `# ${PKG_NAME} install ${timestamp()}`,
      '- insert:',
      `    - id: ${ENTRY_ID}`,
      `      name: ${PKG_NAME}`,
      '      config: {}',
      '',
    ].join('\n')
    const trimmed = patchText.trim()
    const base = trimmed === '' || trimmed === '[]' ? '' : `${patchText.replace(/\s*$/, '')}\n\n`
    await writeFile(patchFile, `${base}${block}`, 'utf8')
    console.log(`[ok] 已追加 cordis.patch.yml insert：${ENTRY_ID}`)
    if (saved !== null) console.log(`     备份：${saved}`)
  }

  console.log('')
  console.log('完成。接下来：')
  console.log('  1. 重启 DSH / 关闭窗口从托盘重开，让插件重新加载；')
  console.log('  2. 打开 Web 界面验证：GET /work-progress/api/health 返回 ok:true。')
  console.log('  3. 随便发一条消息，顶部中央应出现转圈 + 流动进度条。')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
