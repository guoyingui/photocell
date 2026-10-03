import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
let choosing = false;
export function folderDialogCommand(platform, linuxProgram = null) {
  if (platform === 'darwin') return { file: '/usr/bin/osascript', args: ['-e', 'POSIX path of (choose folder with prompt "选择照片文件夹")'] };
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "PhotoCull"; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }'] };
  if (linuxProgram) return { file: linuxProgram, args: linuxProgram.endsWith('kdialog')
    ? ['--getexistingdirectory', '.', '--title', 'PhotoCull'] : ['--file-selection', '--directory', '--title=PhotoCull'] };
  return null;
}
export async function nativeFolderCapability(platform = process.platform, env = process.env) {
  if (platform === 'darwin' || platform === 'win32') return folderDialogCommand(platform);
  if (platform !== 'linux' || (!env.DISPLAY && !env.WAYLAND_DISPLAY)) return null;
  for (const name of ['zenity', 'kdialog']) for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, name);
    try { await fs.access(file, fs.constants.X_OK); return folderDialogCommand(platform, file); } catch { /* 下一项 */ }
  }
  return null;
}
export async function chooseNativeFolder({ runner = run, platform = process.platform, env = process.env } = {}) {
  if (choosing) throw Object.assign(new Error('文件夹选择窗口已经打开，请先完成或取消'), { status: 409 });
  choosing = true;
  try {
    const command = await nativeFolderCapability(platform, env);
    if (!command) throw Object.assign(new Error('系统文件夹窗口不可用，请使用页面目录浏览器'), { status: 503 });
    try {
      const { stdout } = await runner(command.file, command.args, { timeout: 300000, maxBuffer: 16384, encoding: 'utf8', windowsHide: true });
      return stdout.replace(/[\r\n]+$/, '') || null;
    } catch (err) {
      if ((platform === 'linux' && err.code === 1) || /\(-128\)|User canceled/i.test(err.stderr ?? '')) return null;
      throw Object.assign(new Error('系统文件夹窗口未能打开，请使用页面目录浏览器'), { status: 503 });
    }
  } finally { choosing = false; }
}
