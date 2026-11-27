/** Entry of the browser app. */
import { checkBrowserPlatform } from '../platform';

const check = checkBrowserPlatform(navigator as Navigator & { userAgentData?: { platform?: string } });
if (!check.ok) {
  document.body.innerHTML = '';
  const box = document.createElement('div');
  box.id = 'platform-block';
  box.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:16px;background:#0e0e14;color:#ccc;font:15px system-ui;text-align:center';
  box.innerHTML = '<div><div style="font-size:20px;color:#fff;margin-bottom:8px">maniamap runs on Linux only</div>Windows (including WSL) is not supported.</div>';
  document.body.appendChild(box);
} else {
  void import('./main');
}
