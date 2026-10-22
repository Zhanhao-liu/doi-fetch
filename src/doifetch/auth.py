"""Access layer: campus WebVPN URL rewriting + persisted login sessions.

The URL scheme is 网瑞达 (WEngine):

    <base>/<scheme>[-<port>]/<hex(iv)><hex(AES-CFB(key, iv, hostname))><path>?<query>

Only the hostname is encrypted; the path stays readable. IV is prepended in hex,
which is why every stock-gateway URL starts with 77726476706e69737468656265737421
(the ASCII bytes of "wrdvpnisthebest!").
"""

from __future__ import annotations

import binascii
import json
import os
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

from . import net
from .config import CONFIG_DIR, PROFILE_DIR, STATE_PATH, ensure_dir, temp_dir
from .schools import School, get as get_school

LOGIN_MARKERS = (
    "统一身份认证",
    "unified identity",
    "wengine_vpn_ticket",
    "please log in",
    "用户登录",
)

# Playwright leaves navigator.webdriver === true, which campus SSO / WAFs use to
# reject a login silently: you type the right password and get bounced back to
# the form. Strip the usual tells before any page script runs.
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
if (!window.chrome) {
  window.chrome = { runtime: {}, loadTimes: function () {}, csi: function () {} };
}
"""


def _read_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_state(state: dict) -> bool:
    try:
        ensure_dir(CONFIG_DIR)
        STATE_PATH.write_text(
            json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        return True
    except OSError:
        return False


def load_cookies(host: str) -> dict:
    entry = _read_state().get("webvpn", {}).get(host, {})
    cookies = entry.get("cookies") or {}
    return cookies if isinstance(cookies, dict) else {}


def save_cookies(host: str, cookies: dict, source: str = "browser") -> bool:
    state = _read_state()
    state.setdefault("webvpn", {})[host] = {
        "cookies": cookies,
        "source": source,
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    return _write_state(state)


def clear_cookies(host: str) -> bool:
    state = _read_state()
    existed = host in state.get("webvpn", {})
    state.get("webvpn", {}).pop(host, None)
    _write_state(state)
    return existed


def parse_cookie_header(raw: str) -> dict:
    """'a=1; b=2' -> {'a': '1', 'b': '2'}"""
    out: dict[str, str] = {}
    for part in (raw or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        if name.strip():
            out[name.strip()] = value.strip()
    return out


@dataclass
class WebVPN:
    school: School

    def convert(self, url: str) -> str:
        """Rewrite an ordinary URL into a gateway URL."""
        try:
            from Crypto.Cipher import AES
        except ImportError as exc:  # pragma: no cover - dependency hint
            raise RuntimeError(
                "WebVPN needs pycryptodome: pip install 'doi-fetch[webvpn]'"
            ) from exc

        parsed = urlparse(url)
        if not parsed.hostname:
            return url

        cipher = AES.new(self.school.key, AES.MODE_CFB, self.school.iv_bytes, segment_size=128)
        encrypted = cipher.encrypt(parsed.hostname.encode("utf-8"))
        hexed = binascii.hexlify(self.school.iv_bytes).decode() + binascii.hexlify(encrypted).decode()

        scheme = (parsed.scheme or "https").lower()
        scheme_part = f"{scheme}-{parsed.port}" if parsed.port else scheme

        out = f"{self.school.base}/{scheme_part}/{hexed}{parsed.path or '/'}"
        if parsed.query:
            out += f"?{parsed.query}"
        return out

    def session(self, cookies: dict | None = None, proxy: str | None = None) -> requests.Session:
        jar = load_cookies(self.school.host) if cookies is None else cookies
        return net.new_session(cookies=jar, proxy=proxy)

    def validate(self, session: requests.Session | None = None, timeout: float = 20) -> bool:
        """True when the gateway serves authenticated content instead of the SSO page."""
        session = session or self.session()
        try:
            resp = session.get(self.school.base + "/", timeout=timeout, allow_redirects=True)
        except requests.RequestException:
            return False
        if "/login" in (resp.url or ""):
            return False
        body = (resp.text or "")[:4000].lower()
        return not any(m.lower() in body for m in LOGIN_MARKERS)


def get_webvpn(name: str) -> WebVPN:
    return WebVPN(school=get_school(name))


def prepare_temp() -> Path:
    """Point TMP/TEMP/TMPDIR at a directory that accepts writes.

    Playwright's Node driver calls mkdtemp with no fallback, so a locked-down
    %TEMP% surfaces as ``EPERM ... mkdtemp playwright-artifacts-XXXXXX`` before
    any window appears. Python's own tempfile silently falls back; the driver
    does not, so we move the target instead.
    """
    path = temp_dir()
    for name in ("TEMP", "TMP", "TMPDIR"):
        os.environ[name] = str(path)
    tempfile.tempdir = None  # drop Python's cached choice
    return path


def _launch_browser(pw, temp_path: Path):
    """Try the installed Chrome, then Edge, then Playwright's bundled build."""
    args = [
        "--no-proxy-server",
        # keep the browser from advertising itself as automated
        "--disable-blink-features=AutomationControlled",
    ]
    environment = {
        **os.environ,
        "TEMP": str(temp_path),
        "TMP": str(temp_path),
        "TMPDIR": str(temp_path),
    }
    failures: list[str] = []
    for channel in ("chrome", "msedge", None):
        options: dict = {
            "user_data_dir": str(PROFILE_DIR),
            "headless": False,
            "args": args,
            "env": environment,
            "ignore_default_args": ["--enable-automation"],
        }
        if channel:
            options["channel"] = channel
        try:
            return pw.chromium.launch_persistent_context(**options)
        except Exception as exc:  # playwright raises its own Error subclasses
            first_line = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
            failures.append(f"{channel or 'bundled'} -> {first_line}")

    raise RuntimeError(
        "无法启动浏览器：" + " | ".join(failures[:2]) + "\n"
        "可以改用「粘贴 Cookie」：在 Chrome 里登录网关后，"
        "把 Network 里的 Cookie 请求头贴进来。"
    )


def browser_login(
    school_name: str,
    *,
    timeout_s: int = 600,
    poll_s: float = 1.5,
    fresh: bool = True,
    log=None,
) -> dict:
    """Open a real Chrome, let the user finish SSO, then persist the cookies.

    Works for CARSI / WebVPN / EZProxy alike: anything that ends with gateway
    cookies in the browser is captured the same way.

    ``fresh`` drops cookies before starting. A stale CASTGC from an earlier
    half-finished attempt otherwise sends you straight back to the login page
    no matter how many times you type the password.
    """
    say = log or (lambda _message: None)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "browser login needs playwright: pip install 'doi-fetch[browser]' "
            "(it drives your installed Chrome, no extra browser download)"
        ) from exc

    school = get_school(school_name)
    gateway = WebVPN(school)
    ensure_dir(PROFILE_DIR)
    temp_path = prepare_temp()

    with sync_playwright() as pw:
        context = _launch_browser(pw, temp_path)
        try:
            if fresh:
                context.clear_cookies()

            # register the stealth patch before the first real navigation
            context.add_init_script(STEALTH_JS)
            page = context.new_page()
            for stale in context.pages:
                if stale is not page:
                    try:
                        stale.close()
                    except Exception:
                        pass

            page.goto(school.base + "/", wait_until="domcontentloaded", timeout=60_000)

            say(f"已打开：{page.url}")
            say("会跳到 id.ustc.edu.cn（中科大统一身份认证）—— 那是正常页面，不是钓鱼站")
            say(f"请在该窗口完成登录，最多等 {max(1, timeout_s // 60)} 分钟")

            deadline = time.time() + timeout_s
            left_login_page = False
            reported_loop = False
            last_page_text = ""

            while time.time() < deadline:
                if page.is_closed():
                    raise RuntimeError("浏览器窗口被关掉了，登录没完成")

                cookies = {
                    c["name"]: c["value"] for c in context.cookies() if c.get("name")
                }
                url = page.url or ""
                on_cas = "id.ustc.edu.cn" in url or "/cas/login" in url
                on_gateway_login = "wvpn" in url and "/login" in url

                if not on_cas and not on_gateway_login:
                    left_login_page = True
                    try:
                        last_page_text = " ".join(page.inner_text("body").split())[:400]
                    except Exception:
                        pass
                elif left_login_page and not reported_loop:
                    reported_loop = True
                    say("又回到登录页了 —— SSO 把这次登录驳回了。")
                    if last_page_text:
                        say(f"驳回前那页的原文：{last_page_text}")
                    say("若这段文字提示密码/账号/二次验证问题，请先在普通 Chrome 里登录确认")

                ticket = [
                    name
                    for name in cookies
                    if name.startswith("wengine_vpn_ticket") and cookies[name]
                ]
                if ticket and not on_cas:
                    if not save_cookies(school.host, cookies, source="browser"):
                        raise RuntimeError(f"登录成功，但无法写入登录态文件：{STATE_PATH}")
                    say(f"登录成功，已保存 {len(cookies)} 个 cookie")

                    probe = gateway.session(cookies=cookies)
                    if gateway.validate(probe):
                        say("服务端校验通过，现在可以下载付费墙论文了")
                    else:
                        say("提示：服务端校验没通过，但 cookie 已保存，先试下载一篇看看")
                    return cookies

                time.sleep(poll_s)

            raise RuntimeError(
                f"等了 {timeout_s}s 仍未登录成功。若窗口里反复回到登录页，"
                "请改用「手工 Cookie」导入"
            )
        finally:
            context.close()
