"""Double-clickable desktop window: paste a DOI, get the PDF and its SI."""

from __future__ import annotations

import os
import queue
import sys
import threading
import time
import traceback
from pathlib import Path

import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

from . import __version__, auth, schools as school_db
from .config import default_out_dir, load_config, set_value
from .fetch import fetch as run_fetch
from .server import DEFAULT_PORT, Bridge

UI_FONT = ("Microsoft YaHei UI", 10)
MONO_FONT = ("Consolas", 9)
OK_COLOUR = "#0a7d33"
ERR_COLOUR = "#b00020"
WARN_COLOUR = "#8a5a00"


class App:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.events: queue.Queue = queue.Queue()
        self.busy = False
        self.last_dir: Path | None = None
        self._selftest = "--selftest-download" in sys.argv

        root.title("DOI 取件器")
        root.geometry("900x620")
        root.minsize(680, 520)

        self._build()
        self._refresh_gateway_label()
        self._start_bridge()
        self._pump()
        root.protocol("WM_DELETE_WINDOW", self._on_close)

    # --------------------------------------------------------------- bridge --
    def _start_bridge(self) -> None:
        """Local endpoint the browser extension posts to."""
        self.bridge = Bridge(
            out_dir=lambda: Path(self.out_var.get().strip() or default_out_dir()).expanduser(),
            on_log=lambda message: self.events.put(("log", f"  {message}", "muted")),
            on_done=lambda job: self.events.put(("bridge_job", job, None)),
        )
        if not self.bridge.start():
            self._append(
                f"浏览器接口端口 {DEFAULT_PORT} 被占用（可能已有一个实例在运行）", "warn"
            )

    def _on_close(self) -> None:
        try:
            self.bridge.stop()
        except Exception:
            pass
        self.root.destroy()

    # ------------------------------------------------------------------ UI --
    def _build(self) -> None:
        pad = {"padx": 12, "pady": 6}
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(4, weight=1)

        # --- DOI input
        top = ttk.Frame(self.root)
        top.grid(row=0, column=0, sticky="ew", **pad)
        top.columnconfigure(1, weight=1)

        ttk.Label(top, text="DOI 或 doi.org 链接", font=UI_FONT).grid(row=0, column=0, sticky="w")
        self.entry = ttk.Entry(top, font=UI_FONT)
        self.entry.grid(row=0, column=1, sticky="ew", padx=(10, 0), ipady=4)
        self.entry.bind("<Return>", lambda _event: self.start())
        self.entry.focus_set()

        # --- output directory
        out_row = ttk.Frame(self.root)
        out_row.grid(row=1, column=0, sticky="ew", **pad)
        out_row.columnconfigure(1, weight=1)

        ttk.Label(out_row, text="保存到", font=UI_FONT).grid(row=0, column=0, sticky="w")
        self.out_var = tk.StringVar(value=str(default_out_dir()))
        ttk.Entry(out_row, textvariable=self.out_var, font=UI_FONT).grid(
            row=0, column=1, sticky="ew", padx=(10, 6), ipady=4
        )
        ttk.Button(out_row, text="浏览…", command=self._choose_dir).grid(row=0, column=2)
        ttk.Button(out_row, text="打开", command=self._open_folder).grid(row=0, column=3, padx=(6, 0))

        # --- options
        opts = ttk.Frame(self.root)
        opts.grid(row=2, column=0, sticky="ew", **pad)
        self.si_var = tk.BooleanVar(value=True)
        self.open_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(opts, text="下载补充材料（SI）", variable=self.si_var, style="TCheckbutton").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Checkbutton(opts, text="完成后打开文件夹", variable=self.open_var).grid(
            row=0, column=1, sticky="w", padx=(18, 0)
        )
        opts.columnconfigure(2, weight=1)

        self.gateway_label = ttk.Label(opts, text="", font=UI_FONT)
        self.gateway_label.grid(row=0, column=3, sticky="e", padx=(12, 6))
        ttk.Button(opts, text="登录网关", command=self._gateway_login).grid(row=0, column=4, sticky="e")
        ttk.Button(opts, text="读 Chrome", command=self._chrome_import).grid(
            row=0, column=5, sticky="e", padx=(6, 0)
        )
        ttk.Button(opts, text="粘贴 Cookie", command=self._cookie_dialog).grid(
            row=0, column=6, sticky="e", padx=(6, 0)
        )

        # --- action row
        action = ttk.Frame(self.root)
        action.grid(row=3, column=0, sticky="ew", **pad)
        action.columnconfigure(1, weight=1)

        self.start_btn = ttk.Button(action, text="开始下载", command=self.start)
        self.start_btn.grid(row=0, column=0)
        self.progress = ttk.Progressbar(action, mode="indeterminate", length=180)
        self.progress.grid(row=0, column=1, sticky="w", padx=12)
        self.status = ttk.Label(action, text="就绪", font=UI_FONT)
        self.status.grid(row=0, column=2, sticky="e")

        # --- log
        log_frame = ttk.Frame(self.root)
        log_frame.grid(row=4, column=0, sticky="nsew", padx=12, pady=(0, 12))
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)

        self.log_box = tk.Text(
            log_frame, wrap="word", font=MONO_FONT, state="disabled", relief="flat",
            background="#fbfbfb", padx=8, pady=6,
        )
        self.log_box.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(log_frame, command=self.log_box.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.log_box.configure(yscrollcommand=scroll.set)
        self.log_box.tag_configure("ok", foreground=OK_COLOUR)
        self.log_box.tag_configure("err", foreground=ERR_COLOUR)
        self.log_box.tag_configure("warn", foreground=WARN_COLOUR)
        self.log_box.tag_configure("muted", foreground="#777777")

        self._append(f"DOI 取件器 v{__version__}  粘贴 DOI 后按回车", "muted")

    # -------------------------------------------------------------- helpers --
    def _append(self, text: str, tag: str | None = None) -> None:
        self.log_box.configure(state="normal")
        self.log_box.insert("end", text + "\n", tag or ())
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def log(self, text: str) -> None:
        """Thread-safe logging (called from the worker)."""
        self.events.put(("log", text, None))

    def _choose_dir(self) -> None:
        chosen = filedialog.askdirectory(initialdir=self.out_var.get() or str(Path.home()))
        if chosen:
            self.out_var.set(chosen)

    def _open_folder(self) -> None:
        target = Path(self.out_var.get() or default_out_dir())
        if self.last_dir and self.last_dir.exists():
            target = self.last_dir
        try:
            target.mkdir(parents=True, exist_ok=True)
            os.startfile(str(target))  # type: ignore[attr-defined]
        except OSError as exc:
            messagebox.showerror("打不开", str(exc))

    def _refresh_gateway_label(self) -> None:
        school = load_config().get("school") or ""
        self.gateway_label.configure(text=f"网关：{school}" if school else "网关：未设置")
        self.gateway_label.configure(foreground="" if school else WARN_COLOUR)

    # ------------------------------------------------------- manual cookies --
    def _chrome_import(self) -> None:
        """Pull the gateway cookie out of the user's own Chrome/Edge profile."""
        from .cookies import CookieReadError, gateway_cookie_from_chrome

        name = load_config().get("school") or ""
        if not name:
            messagebox.showinfo("先选学校", "请先用「登录网关」选一次学校（如 ustc），再来读取。")
            return

        try:
            school = school_db.get(name)
        except ValueError as exc:
            messagebox.showerror("学校无效", str(exc))
            return

        try:
            found = gateway_cookie_from_chrome(school.host)
        except CookieReadError as exc:
            messagebox.showwarning("读不到 Chrome 的 cookie", str(exc))
            self._append(f"  读 Chrome 失败：{exc}", "err")
            return
        except Exception as exc:
            messagebox.showerror("读取失败", f"{type(exc).__name__}: {exc}")
            return

        if not found:
            messagebox.showwarning(
                "没找到网关 cookie",
                "Chrome 里没有这个网关的登录 cookie。\n先在 Chrome 里登录网关，再回来点一次。",
            )
            return

        if not auth.save_cookies(school.host, found, source="chrome"):
            messagebox.showerror("保存失败", "无法写入登录态文件。")
            return

        self._refresh_gateway_label()
        self._append(f"  ✓ 从 Chrome 读到 {len(found)} 个 cookie（{school.name}）", "ok")
        self.status.configure(text="网关已就绪")

    def _cookie_dialog(self) -> None:
        """Fallback that needs neither Playwright nor a working %TEMP%."""
        win = tk.Toplevel(self.root)
        win.title("手工导入 Cookie")
        win.geometry("640x400")
        win.transient(self.root)
        win.grab_set()

        ttk.Label(
            win,
            text=(
                "1. 在 Chrome 里登录网关（如 https://wvpn.ustc.edu.cn）\n"
                "2. F12 → Network → 任一请求 → 复制请求头里的 Cookie 整行\n"
                "3. 粘到下面，点「保存」"
            ),
            font=UI_FONT,
            justify="left",
        ).pack(anchor="w", padx=12, pady=(12, 6))

        school_row = ttk.Frame(win)
        school_row.pack(fill="x", padx=12, pady=4)
        ttk.Label(school_row, text="学校", font=UI_FONT).pack(side="left")
        school_var = tk.StringVar(value=load_config().get("school") or "ustc")
        ttk.Entry(school_row, textvariable=school_var, width=26, font=UI_FONT).pack(
            side="left", padx=8
        )

        text = tk.Text(win, height=9, font=MONO_FONT, wrap="char")
        text.pack(fill="both", expand=True, padx=12, pady=6)
        text.focus_set()

        def save() -> None:
            raw = text.get("1.0", "end").strip()
            parsed = auth.parse_cookie_header(raw)
            if not parsed:
                messagebox.showerror("解析失败", "没从这段文本里解析出任何 cookie。", parent=win)
                return
            try:
                school = school_db.get(school_var.get().strip() or "ustc")
            except ValueError as exc:
                messagebox.showerror("学校无效", str(exc), parent=win)
                return

            if not auth.save_cookies(school.host, parsed, source="manual"):
                messagebox.showerror("保存失败", "无法写入登录态文件，请检查目录权限。", parent=win)
                return
            set_value("school", school.name)
            self._refresh_gateway_label()
            self._append(f"  ✓ 已导入 {len(parsed)} 个 cookie（{school.name}）", "ok")
            self.status.configure(text="网关已就绪")
            win.destroy()

        buttons = ttk.Frame(win)
        buttons.pack(fill="x", padx=12, pady=(0, 12))
        ttk.Button(buttons, text="取消", command=win.destroy).pack(side="right")
        ttk.Button(buttons, text="保存", command=save).pack(side="right", padx=(0, 8))

    # ---------------------------------------------------------------- login --
    def _gateway_login(self) -> None:
        if self.busy:
            return
        current = load_config().get("school") or "ustc"
        name = simpledialog.askstring(
            "登录校园网关",
            "学校名称或别名（如 ustc / 中科大）：",
            initialvalue=current,
            parent=self.root,
        )
        if not name:
            return

        # record the choice even when the login itself fails, so the other
        # buttons (读 Chrome / 粘贴 Cookie) know which gateway to target
        try:
            set_value("school", school_db.get(name).name)
            self._refresh_gateway_label()
        except ValueError:
            pass

        self._set_busy(True, "等待浏览器登录…")
        self._append(
            "正在打开 Chrome。注意：会跳到 id.ustc.edu.cn（中科大统一身份认证），"
            "那是正常页面，不是钓鱼站。",
            "warn",
        )

        def relay(message: str) -> None:
            self.events.put(("log", f"  {message}", "muted"))

        def work() -> None:
            error: str | None = None
            cookies: dict = {}
            try:
                from .auth import browser_login

                cookies = browser_login(name, timeout_s=600, log=relay)
            except Exception as exc:
                error = str(exc).splitlines()[0] if str(exc) else type(exc).__name__

            # clear the spinner before any modal dialog blocks the pump loop
            self.events.put(("idle", None, None))
            if error:
                self.events.put(("gateway_failed", error, None))
            else:
                self.events.put(("gateway", name, len(cookies)))

        threading.Thread(target=work, daemon=True).start()

    # --------------------------------------------------------------- download --
    def start(self) -> None:
        if self.busy:
            return
        raw = self.entry.get().strip()
        if not raw:
            messagebox.showinfo("需要 DOI", "请先粘贴一个 DOI 或 doi.org 链接。")
            return

        targets = raw.replace("\n", " ").split()
        out_dir = Path(self.out_var.get().strip() or default_out_dir()).expanduser()
        want_si = bool(self.si_var.get())
        open_after = bool(self.open_var.get())

        if not self._selftest:
            # a self-test must never rewrite the user's saved preferences
            set_value("out_dir", str(out_dir))
        self._set_busy(True, f"下载中（{len(targets)} 篇）…")
        self._append("")
        for target in targets:
            self._append(f"▶ {target}", "muted")

        def work() -> None:
            ok = 0
            last: Path | None = None
            for target in targets:
                try:
                    report = run_fetch(
                        target, out=out_dir, want_si=want_si, log=self.log
                    )
                except Exception as exc:
                    self.events.put(("log", f"  失败：{exc}", "err"))
                    continue

                if report.ok:
                    ok += 1
                    last = Path(report.workdir)
                    self.events.put(
                        ("log", f"  ✓ 正文 + {len(report.si_assets)} 个 SI  →  {report.workdir}", "ok")
                    )
                else:
                    self.events.put(("log", f"  ✗ {report.pdf_error}", "err"))
                    for note in report.notes[:3]:
                        self.events.put(("log", f"    · {note}", "muted"))
                    if report.si_assets:
                        self.events.put(
                            ("log", f"    （SI 仍拿到 {len(report.si_assets)} 个）", "muted")
                        )
            self.events.put(("finished", (ok, len(targets), last, open_after), None))

        threading.Thread(target=work, daemon=True).start()

    def _set_busy(self, busy: bool, status: str | None = None) -> None:
        self.busy = busy
        self.start_btn.configure(state="disabled" if busy else "normal")
        if busy:
            self.progress.start(12)
        else:
            self.progress.stop()
        if status is not None:
            self.status.configure(text=status)

    # ----------------------------------------------------------------- queue --
    def _pump(self) -> None:
        try:
            while True:
                kind, payload, extra = self.events.get_nowait()

                if kind == "log":
                    self._append(payload, extra)
                elif kind == "gateway":
                    set_value("school", payload)
                    self._refresh_gateway_label()
                    self._append(f"  ✓ 网关已登录（{extra} 个 cookies）：{payload}", "ok")
                    self.status.configure(text="网关已登录")
                elif kind == "bridge_job":
                    job = payload
                    if job.status == "done":
                        self.last_dir = Path(job.workdir) if job.workdir else self.last_dir
                        self._append(
                            f"  ✓ 浏览器任务完成：{job.doi}（SI {job.si_count} 个）→ {job.workdir}",
                            "ok",
                        )
                        if self.open_var.get() and job.workdir:
                            try:
                                os.startfile(job.workdir)  # type: ignore[attr-defined]
                            except OSError:
                                pass
                    else:
                        self._append(f"  ✗ 浏览器任务失败：{job.doi} — {job.error}", "err")
                elif kind == "gateway_failed":
                    self._append(f"  登录失败：{payload}", "err")
                    self.status.configure(text="登录失败")
                    if messagebox.askyesno(
                        "浏览器登录失败",
                        f"{payload}\n\n是否改用手工导入 Cookie？（不需要 Playwright）",
                    ):
                        self._cookie_dialog()
                elif kind == "error":
                    self._append(payload, "err")
                    self.status.configure(text="出错")
                elif kind == "idle":
                    self._set_busy(False, "就绪")
                elif kind == "finished":
                    ok, total, last_dir, open_after = payload
                    self._set_busy(False, f"完成 {ok}/{total}")
                    self._append("")
                    if ok:
                        self._append(f"完成：{ok}/{total} 篇已保存", "ok")
                    else:
                        self._append("没有下载成功，可尝试登录校园网关", "err")
                    if last_dir:
                        self.last_dir = last_dir
                        if open_after:
                            try:
                                os.startfile(str(last_dir))  # type: ignore[attr-defined]
                            except OSError:
                                pass
        except queue.Empty:
            pass
        self.root.after(120, self._pump)


def main() -> None:
    if "--selftest" in sys.argv:
        root = tk.Tk()
        app = App(root)
        app._append("selftest", "ok")
        root.update()
        # build the fallback dialog too, so a broken layout fails fast
        app._cookie_dialog()
        root.update()
        for child in list(root.winfo_children()):
            if isinstance(child, tk.Toplevel):
                child.destroy()
        root.update()
        root.destroy()
        print("gui selftest ok")
        return

    if "--selftest-download" in sys.argv:
        index = sys.argv.index("--selftest-download")
        doi = sys.argv[index + 1]
        target = Path.cwd() / "_gui_selftest"
        root = tk.Tk()
        app = App(root)
        app.entry.insert(0, doi)
        app.out_var.set(str(target))
        app.open_var.set(False)
        app.start()
        deadline = time.time() + 300
        while time.time() < deadline and app.busy:
            root.update()
            time.sleep(0.05)
        root.update()
        files = sorted(p.name for p in target.rglob("*") if p.is_file()) if target.exists() else []
        print("gui download selftest: busy =", app.busy)
        print("files:", files)
        root.destroy()
        return

    try:
        root = tk.Tk()
        App(root)
        root.mainloop()
    except Exception:
        detail = traceback.format_exc()
        try:
            Path.home().joinpath("doi-fetch-crash.log").write_text(detail, encoding="utf-8")
        except OSError:
            pass
        try:
            messagebox.showerror("启动失败", detail[-1500:])
        except tk.TclError:
            print(detail, file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
