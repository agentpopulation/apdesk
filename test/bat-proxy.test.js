// get-node.bat behind a proxy: HTTPS_PROXY first (curl reads it itself), else the proxy set in Windows for this user,
// read with reg (HKCU) and given to curl with the person's own Windows sign-in. Read here as text: no cmd.exe on Linux.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const raw = fs.readFileSync(path.join(ROOT, 'setup', 'get-node.bat'), 'latin1');
const lines = raw.split('\r\n').map(l => l.trim()).filter(l => l && !/^rem\b/i.test(l));
const at = (t) => lines.indexOf(t);
const URL_ = '"https://nodejs.org/dist/v%VER%/%NAME%.zip"';

test('55: the Windows proxy is looked up only when HTTPS_PROXY is not set, and only then given to curl', () => {
  assert.ok(at('set "PROXY="') > 0 && at('set "PROXY="') < at('if not defined HTTPS_PROXY call :winproxy'));
  assert.ok(at('if not defined HTTPS_PROXY call :winproxy') < at('if defined PROXY goto :viaproxy'));
  const plain = lines.filter(l => l.startsWith('curl '));
  assert.equal(plain.length, 2, 'one download without a proxy option, one through the Windows proxy');
  assert.equal(plain[0], `curl -fL --retry 2 -o "%ZIP%" ${URL_}`);
  assert.equal(plain[1], `curl -fL --retry 2 --proxy "%PROXY%" --proxy-anyauth --proxy-user : -o "%ZIP%" ${URL_}`);
  // both downloads reach the same errorlevel check, and the checksum is still checked before unpacking
  assert.equal(lines[at(plain[0]) + 1], 'goto :fetched'); assert.equal(lines[at(plain[1]) + 1], ':fetched'); assert.equal(lines[at(':fetched') + 1], 'if errorlevel 1 goto :nodownload');
  assert.ok(lines.findIndex(l => l.startsWith('certutil -hashfile')) > at(':fetched'));
  // the proxy address is not printed
  assert.equal(lines.some(l => /^echo\b.*%PROXY%/i.test(l)), false);
});

test('55: the Windows proxy: ProxyEnable 0x1, then ProxyServer as one address or the https= (else http=) part of a list', () => {
  const sub = lines.slice(at(':winproxy'), at(':proxypart'));
  const key = '"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"';
  assert.ok(sub.some(l => l.includes(`reg query ${key} /v ProxyEnable 2^>nul ^| findstr /i "ProxyEnable"') do set "PXON=%%a"`)));
  assert.ok(sub.includes('if not "%PXON%"=="0x1" exit /b 0'), 'no proxy when "Use a proxy server" is off');
  assert.ok(sub.some(l => l.startsWith('for /f "tokens=2,*" %%a in (') && l.includes(`reg query ${key} /v ProxyServer`) && l.endsWith('do set "PXSRV=%%b"')));
  assert.ok(sub.includes('echo %PXSRV%| findstr "=" >nul || exit /b 0'), 'a single address is used as it is');
  assert.ok(sub.includes('for %%e in ("%PXSRV:;=" "%") do call :proxypart %%e'));
  assert.ok(sub.includes('if not defined PROXY set "PROXY=%PXHTTP%"'));
  const part = lines.slice(at(':proxypart'), at(':proxypart') + 5);
  assert.deepEqual(part, [':proxypart', 'set "PART=%~1"', 'if /i "%PART:~0,6%"=="https=" set "PROXY=%PART:~6%"', 'if /i "%PART:~0,5%"=="http=" set "PXHTTP=%PART:~5%"', 'exit /b 0']);
  // the subroutines are reached only by call: the main part ends before them
  const main = lines.slice(0, at(':nodownload'));
  assert.equal(main.includes(':winproxy'), false);
  assert.equal(lines[at(':winproxy') - 1], 'exit /b 1', 'the line before :winproxy ends the script');
  assert.equal(/HKLM|powershell|netsh/i.test(lines.join('\n')), false, 'this user\'s settings only, and only tools the script names');
});

test('55: the same steps worked out in JavaScript give the proxy curl gets for each kind of Windows setting', () => {
  // a line for line copy of :winproxy and :proxypart, so the cases a PC can have are run somewhere
  const pick = (on, server) => {
    if (on !== '0x1' || !server) return null;
    if (!server.includes('=')) return server;
    let proxy = null; let http = null;
    for (const part of server.split(';')) { if (/^https=/i.test(part)) proxy = part.slice(6); if (/^http=/i.test(part)) http = part.slice(5); }
    return proxy || http;
  };
  assert.equal(pick('0x0', 'proxy.corp:8080'), null);
  assert.equal(pick('0x1', 'proxy.corp:8080'), 'proxy.corp:8080');
  assert.equal(pick('0x1', 'http=a.corp:80;https=b.corp:443;ftp=c:21'), 'b.corp:443');
  assert.equal(pick('0x1', 'http=a.corp:80;ftp=c:21'), 'a.corp:80');
  assert.equal(pick('0x1', 'socks=s.corp:1080'), null, 'a socks-only setting is not used');
  assert.equal(pick('0x1', ''), null);
  // the batch file splits the list the same way: ";" becomes the gap between quoted parts
  assert.ok(raw.includes('"%PXSRV:;=" "%"'));
});

test('55: after a failed download the message also names the proxy way, in plain words', () => {
  const after = lines.slice(at(':nodownload'), at(':winproxy')).join('\n');
  assert.match(after, /Check your internet connection and try again\./);
  assert.match(after, /through a proxy, set HTTPS_PROXY for your account/);
  assert.match(after, /ask whoever looks after this PC for it/);
});
