import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const previewHome = resolve(root, '.test-home')
const env = { ...process.env, DSH_HOME: previewHome }

function run(args, inheritedEnv = env) {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: root, env: inheritedEnv, stdio: 'inherit' })
    child.once('error', no)
    child.once('exit', code => code === 0 ? yes() : no(new Error(`Command exited with code ${code}`)))
  })
}

await run(['scripts/build.mjs'])
await run([dsh, 'plugin', '--profile', 'web', 'add', root])
console.log(`\n隔离预览数据目录：${previewHome}\n此预览不会读取或修改日常使用的 Harness 配置。\n`)
const child = spawn(process.execPath, [dsh, 'web', '--no-open', '--port', process.env.KEY_POOL_PREVIEW_PORT ?? '3089'], {
  cwd: root, env, stdio: 'inherit',
})
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 0 })
