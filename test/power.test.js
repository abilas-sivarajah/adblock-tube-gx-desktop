import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powerCommands } from '../src/main/power.js';

test('PC ausschalten: erzwungen auf jedem System', () => {
  assert.deepEqual(powerCommands('restart', 'win32', { SystemRoot: 'C:\\WINDOWS' }), [['C:\\WINDOWS\\System32\\shutdown.exe', ['/r', '/f', '/t', '0']]]);
  assert.deepEqual(powerCommands('shutdown', 'win32', {})[0][1], ['/s', '/f', '/t', '0']);
  assert.deepEqual(powerCommands('shutdown', 'linux', {})[0], ['systemctl', ['poweroff', '-i']]);
  assert.deepEqual(powerCommands('restart', 'linux', {})[0], ['systemctl', ['reboot', '-i']]);
  assert.match(powerCommands('restart', 'darwin', {})[0][1][1], /aevtrrst/);
  assert.match(powerCommands('shutdown', 'darwin', {})[0][1][1], /aevtrsdn/);
});
