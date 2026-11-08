import { describe, expect, it } from 'vitest';
import { deviceDisplayName, grantText, parseDeviceGrant, parseDeviceTool } from './devices';

describe('device helpers', () => {
  it('names a device from its slug', () => {
    expect(deviceDisplayName('pc')).toBe('PC');
    expect(deviceDisplayName('my-laptop')).toBe('My laptop');
  });
  it('parses device tools in both spellings, and nothing else', () => {
    expect(parseDeviceTool('device-pc__shell_run')).toMatchObject({ slug: 'pc', device: 'PC', tool: 'shell_run' });
    expect(parseDeviceTool('device-work-laptop/fs_read')).toMatchObject({ slug: 'work-laptop', tool: 'fs_read' });
    expect(parseDeviceTool('sandbox__run_bash')).toBeNull();
  });
  it('reads device command grants', () => {
    expect(parseDeviceGrant('cmd@device-pc:git push')).toEqual({ device: 'PC', command: 'git push' });
    expect(parseDeviceGrant('cmd:git push')).toBeNull();
  });
  it('renders grants readably', () => {
    expect(grantText('cmd@device-pc:git push')).toBe('PC $ git push');
    expect(grantText('cmd:npm install')).toBe('$ npm install');
    expect(grantText('web:example.com')).toBe('web:example.com');
  });
});
