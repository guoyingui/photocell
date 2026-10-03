import { describe, expect, it, vi } from 'vitest';
import { chooseNativeFolder, folderDialogCommand, nativeFolderCapability } from './nativeFolder.js';
describe('系统目录窗口的调用方式', () => {
  it('选择保留路径中的空格和 Unicode，取消返回空，失败可重试，并阻止重复打开窗口', async () => {
    const runner = vi.fn().mockResolvedValueOnce({ stdout: '/tmp/婚礼 \n' }).mockRejectedValueOnce({ code: 1, stderr: 'User canceled. (-128)' });
    expect(await chooseNativeFolder({ platform: 'darwin', runner })).toBe('/tmp/婚礼 ');
    expect(await chooseNativeFolder({ platform: 'darwin', runner })).toBeNull();
    runner.mockRejectedValueOnce({ code: 1, stderr: 'permission denied' });
    await expect(chooseNativeFolder({ platform: 'darwin', runner })).rejects.toMatchObject({ status: 503 });
    let finish;
    runner.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = chooseNativeFolder({ platform: 'darwin', runner });
    await Promise.resolve();
    await expect(chooseNativeFolder({ platform: 'darwin', runner })).rejects.toMatchObject({ status: 409 });
    finish({ stdout: '/tmp/photos' }); expect(await first).toBe('/tmp/photos');
  });
  it('macOS 与 Windows 使用固定参数，不拼接用户路径或 shell 命令', () => {
    expect(folderDialogCommand('darwin')).toMatchObject({ file: '/usr/bin/osascript', args: ['-e', expect.stringContaining('choose folder')] });
    expect(folderDialogCommand('win32').args).toContain('-STA');
    expect(folderDialogCommand('win32').args.join(' ')).toContain('UTF8Encoding');
    expect(folderDialogCommand('linux', '/usr/bin/zenity').args).toContain('--directory');
    expect(folderDialogCommand('linux', '/usr/bin/kdialog').args).toContain('--getexistingdirectory');
  });
  it('没有图形桌面与不支持的平台不展示系统窗口入口', async () => {
    expect(await nativeFolderCapability('linux', {})).toBeNull(); expect(await nativeFolderCapability('unsupported', {})).toBeNull();
  });
});
