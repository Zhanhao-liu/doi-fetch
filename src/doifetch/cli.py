"""Command line interface."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

import typer

from . import __version__, auth, schools as schools_mod
from .config import config_path, load_config, set_value
from .fetch import fetch as run_fetch

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="DOI in, full-text PDF + supplementary materials out.",
)
auth_app = typer.Typer(no_args_is_help=True, help="Manage campus login sessions.")
app.add_typer(auth_app, name="auth")


def _log(message: str) -> None:
    typer.echo(message)


@app.command()
def fetch(
    dois: list[str] = typer.Argument(..., help="One or more DOIs (or doi.org URLs)."),
    out: Optional[Path] = typer.Option(None, "--out", "-o", help="Output root directory."),
    si: bool = typer.Option(True, "--si/--no-si", help="Also download supplementary materials."),
    auth_mode: str = typer.Option(
        "auto", "--auth", help="auto | none | webvpn"
    ),
    school: Optional[str] = typer.Option(None, "--school", help="Override the configured school."),
    timeout: float = typer.Option(40.0, "--timeout", help="Per-request timeout (seconds)."),
    as_json: bool = typer.Option(False, "--json", help="Emit machine-readable JSON."),
) -> None:
    """Download the PDF (and SI) for each DOI."""
    reports = []
    failures = 0

    for raw in dois:
        if not as_json:
            typer.echo(f"\n{raw}")
        try:
            report = run_fetch(
                raw,
                out=out,
                want_si=si,
                auth_mode=auth_mode,
                school=school,
                timeout=timeout,
                log=None if as_json else _log,
            )
        except ValueError as exc:
            failures += 1
            if as_json:
                reports.append({"doi": raw, "ok": False, "error": str(exc)})
            else:
                typer.secho(f"  invalid input: {exc}", fg=typer.colors.RED)
            continue

        reports.append(report.to_dict())
        if not report.ok:
            failures += 1

        if not as_json:
            if report.ok:
                typer.secho(f"  -> {report.workdir}", fg=typer.colors.GREEN)
            else:
                typer.secho(f"  ! {report.pdf_error}", fg=typer.colors.YELLOW)
                if report.notes:
                    for note in report.notes[:4]:
                        typer.echo(f"    note: {note}")
                typer.echo("    tip: run `doi-fetch login` once to route through your campus gateway")

    if as_json:
        typer.echo(json.dumps(reports, indent=2, ensure_ascii=False))
    elif len(dois) > 1:
        ok = len(reports) - failures
        typer.echo(f"\n{ok}/{len(dois)} downloaded")

    raise typer.Exit(code=0 if failures == 0 else 1)


@app.command()
def login(
    school: Optional[str] = typer.Option(None, "--school", "-s", help="School name or alias, e.g. ustc."),
    timeout: int = typer.Option(300, "--timeout", help="Seconds to wait for you to finish logging in."),
) -> None:
    """Open a real Chrome so you can log in once; cookies are saved for reuse."""
    name = school or load_config().get("school") or ""
    if not name:
        typer.secho("no school given. Try: doi-fetch login --school ustc", fg=typer.colors.RED)
        raise typer.Exit(code=2)

    try:
        entry = schools_mod.get(name)
    except ValueError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        raise typer.Exit(code=2)

    typer.echo(f"School: {entry.name} ({entry.province}) -> {entry.base}")
    typer.echo("会跳到 id.ustc.edu.cn 一类统一身份认证页，那是正常页面。")
    try:
        cookies = auth.browser_login(
            entry.name, timeout_s=timeout, log=lambda message: typer.echo(f"  {message}")
        )
    except RuntimeError as exc:
        typer.secho(f"\n{exc}", fg=typer.colors.RED)
        typer.echo(
            "\nNo browser available? Import cookies by hand instead:\n"
            "  1. Log in at " + entry.base + " in Chrome\n"
            "  2. DevTools > Application > Cookies, copy the Cookie header\n"
            "  3. doi-fetch auth import-cookie --school " + name
        )
        raise typer.Exit(code=1)

    set_value("school", entry.name)
    typer.secho(f"saved {len(cookies)} cookies; default school set to {entry.name}", fg=typer.colors.GREEN)


@auth_app.command("from-chrome")
def auth_from_chrome(school: Optional[str] = typer.Option(None, "--school", "-s")) -> None:
    """Copy the gateway cookie out of your own Chrome/Edge profile."""
    from .cookies import CookieReadError, gateway_cookie_from_chrome

    name = school or load_config().get("school") or ""
    if not name:
        typer.secho("no school configured; pass --school ustc", fg=typer.colors.RED)
        raise typer.Exit(code=2)

    entry = schools_mod.get(name)
    typer.echo(f"reading cookies for {entry.host} from the browser store…")
    try:
        found = gateway_cookie_from_chrome(entry.host)
    except CookieReadError as exc:
        typer.secho(str(exc), fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)

    if not found:
        typer.secho("no gateway cookie found - log in once in Chrome first", fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)

    if not auth.save_cookies(entry.host, found, source="chrome"):
        typer.secho("could not write the session file", fg=typer.colors.RED)
        raise typer.Exit(code=1)

    set_value("school", entry.name)
    typer.secho(f"imported {len(found)} cookies from the browser", fg=typer.colors.GREEN)
    typer.echo("verify with: doi-fetch auth status")


@auth_app.command("status")
def auth_status(school: Optional[str] = typer.Option(None, "--school", "-s")) -> None:
    """Show whether the saved campus session still works."""
    name = school or load_config().get("school") or ""
    if not name:
        typer.secho("no school configured", fg=typer.colors.YELLOW)
        raise typer.Exit(code=2)

    entry = schools_mod.get(name)
    cookies = auth.load_cookies(entry.host)
    if not cookies:
        typer.secho(f"{entry.name}: no saved cookies (run: doi-fetch login)", fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)

    ok = auth.WebVPN(entry).validate()
    colour = typer.colors.GREEN if ok else typer.colors.RED
    typer.secho(f"{entry.name}: {len(cookies)} cookies, session {'valid' if ok else 'expired'}", fg=colour)
    raise typer.Exit(code=0 if ok else 1)


@auth_app.command("import-cookie")
def auth_import_cookie(
    cookie: Optional[str] = typer.Option(None, "--cookie", help="Raw Cookie header, e.g. 'a=1; b=2'."),
    school: Optional[str] = typer.Option(None, "--school", "-s"),
) -> None:
    """Store cookies copied from your browser (no Playwright needed)."""
    name = school or load_config().get("school") or ""
    if not name:
        typer.secho("no school configured; pass --school", fg=typer.colors.RED)
        raise typer.Exit(code=2)

    entry = schools_mod.get(name)
    raw = cookie or typer.prompt("Paste the Cookie header")
    parsed = auth.parse_cookie_header(raw)
    if not parsed:
        typer.secho("could not parse any cookie", fg=typer.colors.RED)
        raise typer.Exit(code=1)

    auth.save_cookies(entry.host, parsed, source="manual")
    set_value("school", entry.name)
    typer.secho(f"saved {len(parsed)} cookies for {entry.name}", fg=typer.colors.GREEN)
    typer.echo("verify with: doi-fetch auth status")


@auth_app.command("logout")
def auth_logout(school: Optional[str] = typer.Option(None, "--school", "-s")) -> None:
    """Forget saved campus cookies."""
    name = school or load_config().get("school") or ""
    if not name:
        typer.secho("no school configured", fg=typer.colors.RED)
        raise typer.Exit(code=2)
    entry = schools_mod.get(name)
    removed = auth.clear_cookies(entry.host)
    typer.echo("cleared" if removed else "nothing to clear")


@app.command()
def schools(query: str = typer.Argument("", help="Name, province, or host keyword.")) -> None:
    """Search the built-in gateway list."""
    hits = schools_mod.search(query) if query else schools_mod.all_schools()
    if not hits:
        typer.secho("no match", fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)
    for entry in hits[:40]:
        typer.echo(f"  {entry.name:<24} {entry.province:<6} {entry.base}")
    if len(hits) > 40:
        typer.echo(f"  ... and {len(hits) - 40} more")


@app.command("config")
def config_cmd(
    key: Optional[str] = typer.Argument(None, help="Setting name, e.g. email / out_dir / proxy."),
    value: Optional[str] = typer.Argument(None, help="New value."),
) -> None:
    """Show or change settings."""
    if key and value is not None:
        set_value(key, value)
        typer.secho(f"{key} = {value}", fg=typer.colors.GREEN)
        return

    cfg = load_config()
    typer.echo(f"config file: {config_path()}")
    if not cfg:
        typer.echo("(empty)")
    for k, v in sorted(cfg.items()):
        typer.echo(f"  {k} = {v}")


@app.command()
def batch(
    manifest: Path = typer.Argument(..., exists=True, help="包含 DOI 的 .xlsx 清单。"),
    out: Optional[Path] = typer.Option(None, "--out", "-o", help="输出根目录。"),
    si: bool = typer.Option(True, "--si/--no-si", help="是否同时下载补充材料。"),
    limit: int = typer.Option(0, "--limit", "-n", help="只处理前 N 篇（0 = 全部）。"),
    delay: float = typer.Option(3.0, "--delay", help="每篇之间的间隔秒数。"),
    zot: bool = typer.Option(False, "--zotero/--no-zotero", help="同时写入 Zotero（库中已有则跳过）。"),
    zot_target: str = typer.Option("", "--zotero-target", help="目标分类 ID，如 C9；留空跟随当前选中。"),
    report: Optional[Path] = typer.Option(None, "--report", help="结果表输出路径（默认与清单一同目录）。"),
    resume: bool = typer.Option(False, "--resume", help="读取已有结果表，跳过上次已下载的。"),
    skip_prefix: str = typer.Option("", "--skip-prefix", help="跳过某些 DOI 前缀，逗号分隔，如 10.1016（需网关才能取的出版商）。"),
    auth: Optional[str] = typer.Option(None, "--auth", help="授权方式：auto / webvpn / cookies / none。"),
) -> None:
    """批量处理 xlsx 清单里的 DOI。"""
    from . import batch as batch_mod

    report_path = report or manifest.with_name(manifest.stem + "-结果.xlsx")

    typer.echo(f"读取清单：{manifest}")
    rows = batch_mod.read_manifest(manifest)
    usable = [row for row in rows if row.doi]
    missing = len(rows) - len(usable)
    typer.echo(f"  识别到 {len(usable)} 个 DOI" + (f"，{missing} 行无 DOI" if missing else ""))

    if not usable:
        typer.secho("清单里没有找到 DOI", fg=typer.colors.RED)
        raise typer.Exit(code=2)

    previous = batch_mod.read_previous_report(report_path) if resume else {}

    summary = batch_mod.run_batch(
        rows,
        out=out,
        want_si=si,
        delay=delay,
        limit=limit,
        use_zotero=zot,
        zotero_target=zot_target,
        resume=previous,
        skip_prefixes=skip_prefix.split(",") if skip_prefix else [],
        auth_mode=auth,
        log=lambda message: typer.echo(message),
    )

    batch_mod.write_report(report_path, rows)
    summary.report_path = str(report_path)

    typer.echo("")
    typer.secho(
        f"完成：下载 {summary.downloaded}，部分 {summary.partial}，"
        f"跳过 {summary.skipped}，失败 {summary.failed}"
        + (f"，Zotero 新增 {summary.zotero_added}" if zot else ""),
        fg=typer.colors.GREEN if not (summary.failed or summary.partial) else typer.colors.YELLOW,
    )
    if summary.aborted:
        typer.secho(f"注意：{summary.aborted}", fg=typer.colors.RED)
    typer.echo(f"结果表：{summary.report_path}")

    raise typer.Exit(code=0 if summary.failed == 0 else 1)


@app.command()
def serve(
    port: int = typer.Option(8765, "--port", help="Local port for the browser extension."),
) -> None:
    """Run only the local browser-extension endpoint (no window)."""
    from .server import serve_forever

    serve_forever(port)


@app.command()
def version() -> None:
    """Print the version."""
    typer.echo(f"doi-fetch {__version__}")


def main() -> None:
    # Windows consoles default to GBK/cp1252; force UTF-8 so Chinese names and
    # titles survive.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            pass
    try:
        app()
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
