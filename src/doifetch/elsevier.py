"""Elsevier (ScienceDirect) article retrieval API.

这是 Elsevier 唯一干净的程序化取全文路径：sciencedirect.com 本身挂在
Cloudflare Bot Management 后面，任何自动化浏览器都过不去（实测有头/无头都停在
「请稍候…」挑战页）。

Elsevier 的全文接口要求两件东西：

* **API key** —— 在 dev.elsevier.com 免费创建；
* **机构授权（entitlement）** —— 要么请求来自订阅机构网段，要么带机构
  ``insttoken``。

只有 key、没有机构授权时服务端会回::

    AUTHENTICATION_ERROR:
    Requestor configuration settings insufficient for access to this resource.

注意这个错误**与具体文章无关**：连 Elsevier 自己标为开放获取的文章也一样回它，
所以别误判成"这篇没订阅"。判断依据是 ``abstract`` 端点会返回 404（说明鉴权通过、
只是资源不存在），而这句 403 说明授权没配上。
"""

from __future__ import annotations

import os

import requests

from . import net

API_TEMPLATE = "https://api.elsevier.com/content/article/doi/{doi}"

# Elsevier 文档建议带"描述性 User-Agent"，但 api.elsevier.com 前面套了 Cloudflare：
# 实测只有写着自己名字的 UA 会被判成机器人、返回一大坨 HTML 403，换成浏览器 UA
# 才能拿到正常的 XML service-error。这里按实际行为来。
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# 服务端这几句提示值得单独翻译出来，否则用户只会看到一段 XML
_AUTH_HINT = (
    "机构授权未配置：需要请求来自订阅网段，或配置 insttoken"
    "（`doi-fetch config elsevier_insttoken <token>`）"
)


def _setting(name: str, env: str) -> str:
    from .config import load_config

    value = (load_config().get(name) or "").strip()
    if value:
        return value
    return (os.environ.get(env) or "").strip()


def api_key() -> str:
    return _setting("elsevier_api_key", "ELSEVIER_API_KEY")


def insttoken() -> str:
    return _setting("elsevier_insttoken", "ELSEVIER_INSTTOKEN")


def configured() -> bool:
    return bool(api_key())


def is_elsevier(doi: str) -> bool:
    return (doi or "").lower().startswith("10.1016/")


def article_url(doi: str) -> str:
    return API_TEMPLATE.format(doi=doi)


def _headers(mime: str) -> dict:
    headers = {
        "X-ELS-APIKey": api_key(),
        "Accept": mime,
        "User-Agent": USER_AGENT,
    }
    token = insttoken()
    if token:
        headers["X-ELS-Insttoken"] = token
    return headers


def _error_note(response: requests.Response) -> str:
    body = (response.content or b"")[:400].decode("utf-8", "replace")
    if "insufficient for access" in body or "AUTHENTICATION_ERROR" in body:
        return f"HTTP {response.status_code} 未授权（{_AUTH_HINT}）"
    if "RESOURCE_NOT_FOUND" in body:
        return f"HTTP {response.status_code} 文章不存在"
    if "<!DOCTYPE" in body or "<html" in body.lower():
        return f"HTTP {response.status_code} 被 Cloudflare 拦截（HTML 挑战页）"
    return f"HTTP {response.status_code} {body[:120]}".strip()


def fetch_pdf(
    doi: str,
    *,
    session: requests.Session,
    webvpn=None,
    wvpn_session: requests.Session | None = None,
    timeout: float = 60,
) -> tuple[net.Binary | None, str]:
    """Try the API directly, then through the campus gateway.

    Returns ``(binary, note)``; ``binary`` is None unless a real PDF came back.
    """
    if not configured():
        return None, "未配置 elsevier_api_key"

    url = article_url(doi)
    attempts: list[tuple[str, str, requests.Session]] = [("direct", url, session)]
    if webvpn is not None and wvpn_session is not None:
        attempts.append(("webvpn", webvpn.convert(url), wvpn_session))

    notes: list[str] = []
    for label, target, active in attempts:
        try:
            response = active.get(
                target,
                params={"httpAccept": "application/pdf"},
                headers=_headers("application/pdf"),
                timeout=timeout,
                allow_redirects=True,
            )
        except requests.RequestException as exc:
            notes.append(f"{label}: 网络异常 {type(exc).__name__}")
            continue

        content = response.content or b""
        if response.status_code == 200 and content[:5] == b"%PDF-":
            return (
                net.Binary(
                    url=url,
                    ok=True,
                    content=content,
                    content_type=response.headers.get("Content-Type") or "application/pdf",
                    status_code=response.status_code,
                    final_url=response.url,
                ),
                f"{label}: ok {len(content)} bytes",
            )
        if response.status_code == 200:
            notes.append(f"{label}: HTTP 200 但不是 PDF（{len(content)} bytes）")
        else:
            notes.append(f"{label}: {_error_note(response)}")

    return None, "；".join(notes)
