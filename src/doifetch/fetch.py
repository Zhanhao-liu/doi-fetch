"""Orchestrator: DOI -> full-text PDF + supplementary materials."""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout
from pathlib import Path
from typing import Callable

from . import auth, elsevier, metadata as meta_mod, net, oa, publishers
from .config import (
    contact_email,
    default_out_dir,
    ensure_dir,
    load_config,
    max_si_mb,
    proxy_url,
    si_timeout_s,
)
from .models import Asset, Candidate, Metadata, PdfStatus, Report, SiStatus

Logger = Callable[[str], None]

PUBLIC_DEADLINE = 30.0
AUTH_DEADLINE = 60.0


def _noop(_: str) -> None:
    return None


def fetch(
    doi_raw: str,
    *,
    out: Path | str | None = None,
    want_si: bool = True,
    auth_mode: str = "auto",
    school: str | None = None,
    timeout: float = 40,
    log: Logger | None = None,
    provided_pdf: bytes | None = None,
    landing_hint: str | None = None,
) -> Report:
    """Download the article PDF and its SI. Never raises for network reasons.

    ``provided_pdf`` lets the browser extension hand over bytes it already
    fetched with the user's own Chrome session; the ladder is skipped in that
    case and only SI discovery still runs.
    """
    log = log or _noop
    started = time.time()
    doi = meta_mod.normalize_doi(doi_raw)

    report = Report(doi=doi)
    cfg = load_config()
    proxy = proxy_url()
    session = net.new_session(proxy=proxy)
    email = contact_email()

    # --- 1. metadata -------------------------------------------------------
    meta = Metadata(doi=doi)
    try:
        meta = meta_mod.resolve(session, doi, email)
    except Exception as exc:  # metadata is nice-to-have
        report.notes.append(f"crossref failed: {exc}")
    report.metadata = meta
    log(f"  {meta.title or '(no title from Crossref)'}")

    # --- 2. landing page ---------------------------------------------------
    landing = landing_hint or meta.url or ""
    try:
        landing = meta_mod.resolve_landing(session, doi) or landing
    except Exception:
        pass
    report.landing_url = landing

    # --- 3. auth channel ---------------------------------------------------
    webvpn = None
    school_name = school or cfg.get("school") or ""
    if auth_mode in ("auto", "webvpn") and school_name:
        try:
            webvpn = auth.get_webvpn(school_name)
        except ValueError as exc:
            report.notes.append(f"webvpn disabled: {exc}")
            webvpn = None
        else:
            if not webvpn.validate(webvpn.session(proxy=proxy)):
                if auth_mode == "webvpn":
                    report.notes.append(
                        f"webvpn session for {webvpn.school.name} is not logged in "
                        "(run: doi-fetch login)"
                    )
                    webvpn = None
                else:
                    report.notes.append("webvpn session not logged in - public channels only")
                    webvpn = None

    # --- 4. PDF candidates -------------------------------------------------
    winner: Candidate | None = None
    binary: net.Binary | None = None
    errors: list[str] = []

    if provided_pdf:
        if net.is_document_bytes(provided_pdf):
            binary = net.Binary(
                url=landing or doi,
                ok=True,
                content=provided_pdf,
                content_type="application/pdf",
                status_code=200,
            )
            winner = Candidate(url=landing or doi, source="browser:extension")
            report.notes.append("PDF 由浏览器扩展提供（使用你的 Chrome 登录态）")
            log("  收到浏览器扩展送来的 PDF")
        else:
            report.notes.append("扩展送来的内容不是文档，回退到常规下载链路")

    oa_list, oa_notes = oa.oa_candidates(session, doi, meta, email)
    report.notes.extend(oa_notes)
    direct = publishers.direct_pdf_candidates(doi, landing)

    if winner is None:
        winner, binary, errors = _attempt(
            oa_list, session, timeout=timeout, deadline=PUBLIC_DEADLINE
        )
    if winner is None:
        winner, binary, more = _attempt(
            direct, session, timeout=timeout, deadline=PUBLIC_DEADLINE
        )
        errors.extend(more)

    landing_html, final_url, landing_status = "", "", 0
    wvpn_session = webvpn.session(proxy=proxy) if webvpn else None

    if winner is None:
        landing_html, final_url, landing_status = _landing_html(
            session, landing, webvpn, wvpn_session
        )
        page_pdfs, page_sis = publishers.parse_landing(landing_html, final_url or landing)
        report.notes.append(
            f"landing page: status={landing_status} pdf_links={len(page_pdfs)} si_links={len(page_sis)}"
        )
        if page_pdfs:
            winner, binary, more = _attempt(
                page_pdfs, session, timeout=timeout, deadline=PUBLIC_DEADLINE
            )
            errors.extend(more)

    # --- 4b. Elsevier API ---------------------------------------------------
    # 唯一干净的程序化路径：sciencedirect.com 本身挂在 Cloudflare 后面，
    # 自动化浏览器过不去挑战页，而 Elsevier 的官方接口不受这层影响。
    if winner is None and elsevier.is_elsevier(doi):
        api_binary, api_note = elsevier.fetch_pdf(
            doi,
            session=session,
            webvpn=webvpn,
            wvpn_session=wvpn_session,
            timeout=timeout,
        )
        report.notes.append(f"elsevier api: {api_note}")
        if api_binary is not None and api_binary.is_pdf:
            winner = Candidate(
                url=api_binary.final_url or elsevier.article_url(doi), source="elsevier:api"
            )
            binary = api_binary

    # --- 5. authenticated channel -----------------------------------------
    if winner is None and webvpn and wvpn_session:
        authed = [Candidate(url=webvpn.convert(c.url), source=f"{c.source}|webvpn", referer=c.referer)
                  for c in (direct + [])]
        if not landing_html:
            landing_html, final_url, landing_status = _landing_html(
                session, landing, webvpn, wvpn_session
            )
        page_pdfs, page_sis = publishers.parse_landing(landing_html, final_url or landing)
        authed += [
            Candidate(url=webvpn.convert(c.url), source="landing:pdf|webvpn", referer=c.referer)
            for c in page_pdfs
        ]
        if landing:
            authed.append(
                Candidate(url=webvpn.convert(landing), source="landing:page|webvpn")
            )
        winner, binary, more = _attempt(
            authed, wvpn_session, timeout=timeout, deadline=AUTH_DEADLINE
        )
        errors += [f"{e} (via webvpn)" for e in more]

    # --- 6. persist --------------------------------------------------------
    workdir = _workdir(out, meta, doi)
    report.workdir = str(workdir)

    if winner is not None and binary is not None:
        ensure_dir(workdir)
        pdf_path = workdir / "main.pdf"
        pdf_path.write_bytes(binary.content or b"")
        report.pdf_status = PdfStatus.DOWNLOADED.value
        report.pdf_path = str(pdf_path)
        report.pdf_source = winner.source
        report.pdf_pages = _page_count(pdf_path)
        log(f"  PDF: {winner.source} ({binary.size // 1024} KB, {report.pdf_pages} pages)")
    else:
        report.pdf_error = _classify_failure(errors, landing_status, landing_html)
        report.pdf_status = report.pdf_error.split(":", 1)[0]
        log(f"  PDF: failed ({report.pdf_status})")

    # --- 7. supplementary --------------------------------------------------
    if not want_si:
        report.si_status = SiStatus.SKIPPED.value
    else:
        # The landing page is the primary SI source, so fetch it even when the
        # PDF already came from an OA index.
        if not landing_html and landing:
            landing_html, more_url, more_status = _landing_html(
                session, landing, webvpn, wvpn_session
            )
            final_url = more_url or final_url
            landing_status = more_status or landing_status

        si_candidates = _si_candidates(
            session, doi, meta, landing, landing_html, final_url, webvpn, wvpn_session, report
        )
        if si_candidates:
            ensure_dir(workdir)
            cap_mb = max_si_mb()
            cap_bytes = cap_mb * 1024 * 1024 if cap_mb else net.MAX_BYTES
            log(f"  SI: 发现 {len(si_candidates)} 个候选，开始下载")
            report.si_assets, si_errors = _download_si(
                session,
                si_candidates,
                workdir,
                webvpn,
                wvpn_session,
                timeout,
                cap_bytes,
                si_timeout_s(),
                log,
            )
            if report.si_assets:
                partial = bool(si_errors)
                report.si_status = (SiStatus.PARTIAL if partial else SiStatus.DOWNLOADED).value
                if si_errors:
                    report.si_error = "; ".join(si_errors[:3])
                log(f"  SI: {len(report.si_assets)} file(s)")
            else:
                report.si_status = SiStatus.ERROR.value
                report.si_error = "; ".join(si_errors[:3]) or "no downloadable SI"
                log("  SI: discovered but none downloaded")
        else:
            report.si_status = SiStatus.NONE.value
            log("  SI: none found")

    # --- 8. write sidecars -------------------------------------------------
    report.elapsed = round(time.time() - started, 1)
    if report.pdf_status == PdfStatus.DOWNLOADED.value or report.si_assets:
        ensure_dir(workdir)
        (workdir / "metadata.json").write_text(
            json.dumps(report.metadata.__dict__, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        (workdir / "report.json").write_text(
            json.dumps(report.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8"
        )
    return report


# --- helpers ---------------------------------------------------------------


def _workdir(out, meta: Metadata, doi: str) -> Path:
    root = Path(out).expanduser() if out else default_out_dir()
    return root / (meta.dirname if meta.title else doi.replace("/", "_"))


def _landing_html(session, landing, webvpn, wvpn_session) -> tuple[str, str, int]:
    if not landing:
        return "", "", 0
    html, final_url, status = net.get_text(session, landing, timeout=25)
    if html and status == 200:
        return html, final_url, status
    if webvpn and wvpn_session:
        wrapped = webvpn.convert(landing)
        html2, final2, status2 = net.get_text(wvpn_session, wrapped, timeout=35)
        if html2:
            return html2, final2 or landing, status2
    return html, final_url, status


def _attempt(
    candidates: list[Candidate],
    session,
    *,
    timeout: float,
    deadline: float,
) -> tuple[Candidate | None, net.Binary | None, list[str]]:
    """Download candidates in parallel; first valid PDF wins."""
    errors: list[str] = []
    if not candidates:
        return None, None, errors

    pool = ThreadPoolExecutor(max_workers=min(6, len(candidates)))
    futures = {
        pool.submit(net.download, session, c.url, timeout=timeout, referer=c.referer): c
        for c in candidates
    }
    try:
        for future in as_completed(futures, timeout=deadline):
            cand = futures[future]
            try:
                binary = future.result()
            except Exception as exc:
                errors.append(f"{cand.source}: {exc}")
                continue
            if net.looks_like_pdf(binary) and binary.size > 3_000:
                pool.shutdown(wait=False, cancel_futures=True)
                return cand, binary, errors
            detail = binary.error or ("html page" if binary.looks_html() else "not a PDF")
            errors.append(f"{cand.source}: {detail}")
    except FuturesTimeout:
        errors.append(f"deadline {deadline:.0f}s reached")
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return None, None, errors


def _classify_failure(errors: list[str], landing_status: int, html: str) -> str:
    blob = " ".join(errors).lower()
    if any(token in blob for token in ("403", "401", "451", "access denied", "blocked")):
        return f"{PdfStatus.BLOCKED.value}: access denied by publisher"
    if net.looks_like_paywall(None, html):
        return f"{PdfStatus.NEEDS_AUTH.value}: paywalled or login required"
    if landing_status in (401, 403, 451):
        return f"{PdfStatus.BLOCKED.value}: publisher returned HTTP {landing_status}"
    if not errors:
        return f"{PdfStatus.NOT_FOUND.value}: no PDF source found"
    return f"{PdfStatus.NOT_FOUND.value}: {errors[0][:160]}"


def _page_count(path: Path) -> int:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(path)).pages)
    except Exception:
        return 0


def _si_candidates(
    session,
    doi: str,
    meta: Metadata,
    landing: str,
    landing_html: str,
    final_url: str,
    webvpn,
    wvpn_session,
    report: Report,
) -> list[Candidate]:
    """Landing page first, then the mirrors that survive paywalls."""
    found: list[Candidate] = []
    base = final_url or landing

    if landing_html:
        _, page_sis = publishers.parse_landing(landing_html, base)
        found.extend(page_sis)

    if not found and webvpn and wvpn_session and landing and not landing_html:
        wrapped = webvpn.convert(landing)
        html, final, status = net.get_text(wvpn_session, wrapped, timeout=35)
        if html:
            _, page_sis = publishers.parse_landing(html, final or landing)
            report.notes.append(f"landing via webvpn: status={status} si_links={len(page_sis)}")
            found.extend(page_sis)

    record = oa.europepmc_record(session, doi)
    pmcid = (record or {}).get("pmcid") or ""
    if pmcid:
        found.extend(publishers.europepmc_si(session, pmcid))
        found.extend(publishers.pmc_si_links(session, pmcid))

    if not found:
        found.extend(publishers.figshare_si(session, doi, meta))

    seen: set[str] = set()
    unique: list[Candidate] = []
    for cand in found:
        # dedupe on the fragment-stripped URL only: PLOS serves every SI file
        # from .../file?type=supplementary&id=...s00N, so dropping the query
        # would collapse four distinct files into one.
        key = cand.url.split("#", 1)[0]
        if key in seen:
            continue
        seen.add(key)
        unique.append(cand)
    return unique[:12]


def _download_si(
    session,
    candidates: list[Candidate],
    target: Path,
    webvpn,
    wvpn_session,
    timeout: float,
    max_bytes: int = net.MAX_BYTES,
    deadline: float = 120.0,
    log: Logger | None = None,
) -> tuple[list[Asset], list[str]]:
    """Fetch every SI candidate in parallel, then persist the valid documents.

    The first candidate that comes back as an HTML login page flips
    ``prefer_gateway``: retrying anonymous requests for the rest of the list
    just doubles the wall time for a site we already know is paywalled.
    """
    log = log or _noop
    assets: list[Asset] = []
    errors: list[str] = []
    hashes: set[str] = set()
    # SI now lives beside main.pdf, so the sidecar names are taken already
    used_names: set[str] = {"main.pdf", "metadata.json", "report.json"}
    prefer_gateway = threading.Event()

    def grab(cand: Candidate) -> net.Binary | None:
        wrapped = webvpn.convert(cand.url) if (webvpn and wvpn_session) else None
        binary: net.Binary | None = None

        if wrapped is None or not prefer_gateway.is_set():
            binary = net.download(
                session, cand.url, timeout=timeout, referer=cand.referer, max_bytes=max_bytes
            )
            if binary.status_code == 202:
                # Figshare answers 202 while it prepares a file; give it a moment
                time.sleep(2.0)
                binary = net.download(
                    session, cand.url, timeout=timeout, referer=cand.referer, max_bytes=max_bytes
                )
            if binary.is_document:
                return binary
            if binary.looks_html() and wrapped:
                prefer_gateway.set()

        if wrapped:
            retry = net.download(
                wvpn_session,
                wrapped,
                timeout=timeout,
                referer=cand.referer,
                max_bytes=max_bytes,
            )
            if retry.is_document or binary is None or not binary.ok:
                return retry
        return binary

    pool = ThreadPoolExecutor(max_workers=min(4, len(candidates)))
    results: dict[str, net.Binary | None] = {}
    try:
        futures = {pool.submit(grab, cand): cand for cand in candidates}
        try:
            for future in as_completed(futures, timeout=deadline):
                cand = futures[future]
                try:
                    results[cand.url] = future.result()
                except Exception:
                    results[cand.url] = None
        except FuturesTimeout:
            done = sum(1 for cand in candidates if cand.url in results)
            errors.append(f"SI 超过 {deadline:.0f}s 总时限，{len(candidates) - done} 个未完成已跳过")
            log(f"  SI: 到达总时限，已收到 {done}/{len(candidates)}")
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    for index, cand in enumerate(candidates, start=1):
        binary = results.get(cand.url)
        if binary is None:
            continue
        if not binary.ok or not binary.content:
            reason = binary.error or "empty"
            if reason.startswith("too large") or "cap" in reason:
                reason = f"超过单个 SI 大小上限，已跳过（{reason}）"
            errors.append(f"{cand.source}: {reason}")
            continue
        if not publishers.looks_like_document(cand.url, binary.content_type, binary.content):
            kind = "HTML 登录页/付费墙" if binary.looks_html() else f"非文件内容 {binary.content_type or '?'}"
            errors.append(f"{cand.source}: 拿到的是 {kind}，已跳过")
            continue

        digest = binary.sha256
        if digest in hashes:
            continue
        hashes.add(digest)

        name = publishers.filename_for(cand.url, binary.content_type, fallback=f"si-{index}")
        stem, dot, ext = name.rpartition(".")
        unique = name
        counter = 2
        while unique in used_names:
            unique = f"{stem}-{counter}.{ext}" if dot else f"{name}-{counter}"
            counter += 1
        used_names.add(unique)

        (target / unique).write_bytes(binary.content)
        assets.append(
            Asset(
                filename=unique,
                source=cand.source,
                url=cand.url,
                size=binary.size,
                sha256=digest,
                content_type=binary.content_type,
            )
        )
    return assets, errors
