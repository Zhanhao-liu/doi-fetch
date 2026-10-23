# doi-fetch

**Give it a DOI, get the article PDF *and* its supplementary information.**

A browser extension (Chrome / Edge, no companion software) plus a Python CLI and desktop window.
It reuses the access you already have in your browser — including campus WebVPN / CARSI — and can file
the paper and its attachments straight into Zotero. Anything a publisher shows a PDF link for, it can
fetch; it never bypasses a paywall. MIT licensed, Windows-first.

> **Install the extension:** grab the zip from [Releases](../../releases/latest), unzip it, then
> `chrome://extensions` → enable Developer mode → *Load unpacked* → pick the unzipped folder.
> Documentation below is in Chinese.

---

给一个 DOI，拿到**全文 PDF** 和**补充材料（SI）**。支持校园网关（WebVPN）授权下载。

## 浏览器扩展：在论文页点一下

**不需要启动任何桌面程序**，扩展自己是完整的。

**安装（一次性，约 30 秒）**

1. 从 [Releases](../../releases/latest) 下载扩展 zip 解压，或直接用本仓库的 `extension` 文件夹
2. 打开 `chrome://extensions`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选择解压出来的文件夹（或本项目的 `extension` 目录）
5. 把「DOI 取件器」固定到工具栏（拼图图标 → 图钉）

**使用**

在论文详情页点工具栏图标，弹出面板：

```
● 论文标题（两行截断）
  10.1038/s41467-023-44674-1
  [2024] [正文 1 个] [补充材料 3 个]

  保存到
  我的文献 / 2024_Yin_machine-learning…   [选择文件夹…]

  ┌──────────── 开始下载 ────────────┐
  正文 PDF              ✓ 已保存
  补充材料 1            ✓ 已保存
  补充材料 2            1 284 KB
```

点「**选择文件夹…**」会弹出系统的目录选择框（和浏览器自带下载的授权一样），选定后在那个目录里为每篇论文建一个子文件夹。不选就存到默认位置：

```
下载/DOI取件/2024_Yin_machine-learning-…/
   main.pdf
   41467_2023_44674_MOESM1_ESM.pdf
   41467_2023_44674_MOESM3_ESM.xlsx
```

**下载过程可以关掉面板**：真正的写入由扩展的离屏文档完成，面板只是显示进度。工具栏徽标同步显示 `1/4`、`✓`、`!`。

**面板会记住任务。** 不小心点到别处、面板收起来，重新点开还是接着显示进度，不会回到「开始下载」让你重复下。已完成的任务也会列出存了哪几个文件。下载结束时会弹一条系统通知。

> 更新扩展文件后，必须到 `chrome://extensions` 点一下这个扩展的「重新加载」，否则浏览器仍在跑旧的 service worker。

### 存入 Zotero

面板底部有「存入 Zotero」勾选框。检测到 Zotero 在运行时会自动勾上并显示版本号；Zotero 没开就灰掉，不影响本地保存。

**可以选择存到哪个分类。** 勾选框下面是分类下拉框，按 Zotero 的树结构缩进列出所有可写分类。默认「跟随 Zotero 当前选中」，也可以在面板里直接选别的，下载时会自动把条目挪过去。

> 技术上是个小弯：Zotero 的 connector 接口只能往「界面里当前选中的分类」写。真正的切换靠 `/connector/updateSession`——它在 `SaveSession.update()` 里先 `selectByID(target)` 改选中项，再 `_updateItems()` 把**已保存**的条目移动到新分类。所以流程是「先存、再挪」，不是「先选、再存」。

下载完成后自动完成两件事：

1. 建一条文献条目
2. 把正文和补充材料作为附件挂到这条条目上

**元数据用 DOI 去 Crossref 取。** Zotero 的 connector 接口本身不做元数据补全（它固定 `attachmentMode: IGNORE`，要求调用方把字段填全），而 Zotero Connector 的元数据是扩展里跑翻译器得到的。Zotero 自己的「通过标识符添加条目」底层也是查 Crossref，所以这里直接取同一份权威数据——期刊、卷、期、页码、ISSN、完整作者列表都比页面 meta 全。没有 DOI 时才退回页面 meta。

条目存进 **Zotero 当前选中的分类**，和 Zotero Connector 的行为一致。单个附件超过 40 MB 会跳过（避免把 100 MB 的复现包塞进去）。

**检测不到 Zotero 时**：这一行右侧会出现「重试」，点一下重新检测；鼠标悬停能看到具体错误。检测失败不会锁死勾选框，你可以强行勾上再试。

> 实现上是在调 Zotero 的本地 connector 接口（`127.0.0.1:23119`）。两个坑值得记：Zotero 会拒绝一切带 `Origin` 却缺少 `X-Zotero-Connector-API-Version` 头的请求（表现为 `Failed to fetch`）；附件元数据走在 HTTP 头里，只能是 ISO-8859-1，所以中文标题要转成 `\uXXXX` 转义。

**原理**

扩展用**你当前浏览器的登录态**直接取文件——和 Zotero Connector 一个思路，也和你手动点「Download PDF」本质相同。不需要任何本地程序。

用了选文件夹时，走浏览器的 File System Access 接口流式写入；没选文件夹时，走 Chrome 自己的下载器（落到「下载」目录）。

**已知限制**

- Chrome 137 起命令行加载扩展被官方禁用，所以只能按上面手动加载一次（之后一直有效）。
- 单页 SI 最多取 12 个。
- 页面本身看不到 PDF 按钮时（无机构权限），扩展也取不到——它不绕付费墙。
- 选了文件夹但系统拒绝授权时，会自动退回「下载」目录，面板里会提示。

**批量取件（在浏览器里跑）**

面板底部展开「批量取件」，粘贴一批 DOI（一行一个，或整段文字直接贴，会自动抽取），点「开始批量」。扩展会依次在你自己的浏览器里打开每篇，取**正文 PDF 和补充材料**，存到 `DOI取件器/批量/<DOI>/`。

**不会再把验证页存成 PDF。** 下载前先流式读取响应开头的字节：不是 `%PDF-` 就判失败并写清原因（"拿到的是网页，不是 PDF"）；补充材料放开到 xlsx/zip/docx 之类，但仍拒绝 HTML。落盘后还会核对一次文件名兜底，万一落成 `.html` 就删掉——所以磁盘上不会堆假 PDF。

关键设计：**遇到人工验证或网关登录就停下来等你**。它会自动切到那个标签页，面板里标成「需人工验证」，你点一下，它自己继续往下跑。所以 Cloudflare 这种专门拦机器人的关卡拦不住批量——过验证的是真人，后面的活是程序干的。

「网关地址」填你的 WebVPN 入口（如 `https://wvpn.ustc.edu.cn`）。填了之后所有地址**包括页面里找到的 PDF 直链**都会改写成网关形式，走校内出口；留空则直连，适合开放获取论文。

> 网关改写是「AES-128-CFB 加密主机名、路径保持明文」。扩展里用纯 JS 实现了一份（`webvpn.js`），输出与 Python 版**逐字节一致**（已在 5 个含端口/查询串/http 的 URL 上比对验证）。

## 批量处理（xlsx 清单）

给一份表格，里面混着 DOI 链接、doi.org 地址甚至带标点的 DOI，程序会自己抽出来批量取件。

```powershell
doi-fetch batch 文献清单.xlsx --out D:\papers --zotero
```

| 参数 | 作用 |
|---|---|
| `--out` | 输出根目录，每篇一个子文件夹 |
| `--delay 6` | 基础间隔秒数。批量最像爬虫，别调太小 |
| `--limit N` | 先跑前 N 篇试水 |
| `--zotero` | 同时归档进 Zotero，**库中已有该 DOI 就跳过** |
| `--zotero-target C9` | 指定目标分类；留空跟随 Zotero 当前选中 |
| `--resume` | 读取上次的结果表，跳过已完成的（断了接着跑） |
| `--skip-prefix 10.1016` | 暂时跳过某些 DOI 前缀，逗号分隔（先把不需要授权的跑完） |
| `--auth webvpn` | 强制走校园网关取件（对付 Elsevier / Science 这类必须机构授权的） |
| `--report 路径` | 结果表位置，默认是 `<清单名>-结果.xlsx` |

**清单怎么读**：不要求固定第几列，会扫描所有单元格里的 DOI；同一 DOI 重复出现只处理一次；首个工作表首行当作表头跳过；第一个工作表里没有 DOI 的行标 `no-doi` 列出来（其他工作表通常是同一批文献的精选视图或说明页，不再重复列出）。说明页里的 `10.1038/文章号` 这类示例文字会被识别并排除，不会拿去下载。

**结果表**每行给出来源行号、DOI、标题、状态、说明（实际取件来源或失败原因）、保存目录、Zotero 结果。

状态含义：

| 状态 | 含义 |
|---|---|
| `downloaded` | 正文拿到了 |
| `partial` | 正文没拿到但补充材料下来了（不少论文的 SI 是独立公开的） |
| `failed` | 都没有 |
| `skipped` | 按要求跳过或上次已完成 |

**防翻车设计（都是实测踩出来的）**：

- **按出版商控制节奏**，不是全局 sleep。对 `nature.com` 连发约 12 次就开始拒绝，所以默认给它 12 秒间隔、Elsevier 15 秒。
- **被拒后冷却 240 秒再试**，而不是整个任务停下。实测冷却后同一出版商又能连续成功 5 篇。
- **同一出版商冷却后仍被拒**，就放弃它的剩余条目、继续跑别的出版商，不让一个站点拖死整批。
- **Zotero 判重先枚举全库 DOI**（本地 API 的 `q` 参数不检索 DOI 字段，这是实测结论），所以不会造重复条目。

> 一个协议层限制：Zotero 的 `saveAttachment` 只能挂到**本次会话刚创建的条目**上。所以库里已有但缺 PDF 的条目，本工具**没法补附件**——只能跳过并告诉你。要补这类得在 Zotero 里单独处理。

**实测数据**（34 篇真实清单，无机构授权，纯开放获取路线）：21 篇拿到全文、6 篇只拿到 SI、6 篇 Elsevier 需网关暂跳过、1 篇被拒。剩余 13 篇的共同点是**正文在付费墙后**，跑一次 `doi-fetch login` 上校园网关后用 `--auth webvpn` 重试即可。

**还没做的**：只支持 `.xlsx`；只给标题不给 DOI 时不会自动去 Crossref 检索（标题匹配有歧义，批量场景下"自动选第一个"会悄悄导错文献，需要人工确认）。

## 双击启动（命令行 / 批量用途）

桌面上已有 **DOI 取件器** 快捷方式（也可直接双击项目里的 `启动取件器.bat`）：

1. 窗口里粘贴 DOI 或 doi.org 链接，回车
2. 点「开始下载」
3. 完成后自动打开文件夹

窗口里能改保存目录、开关 SI 下载、以及「登录网关」（会弹出 Chrome 让你完成统一身份认证）。多个 DOI 用空格或换行隔开可一次下载。

「手工 Cookie」是「登录网关」失败时的兜底，不需要 Playwright：在 Chrome 里登录网关后，F12 → Network → 任一请求 → 复制 `Cookie` 请求头，粘进弹窗保存即可。

快捷方式丢了就重建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\创建桌面快捷方式.ps1
```

命令行等价用法：

```
doi-fetch fetch 10.1038/s41467-023-44674-1
```

输出：

```
10.1038/s41467-023-44674-1
  Machine-learning-accelerated design of high-performance platinum ...
  PDF: unpaywall:publisher (3170 KB, 10 pages)
  SI: 3 file(s)
  -> ~/doifetch-papers/2024_Yin_machine-learning-accelerated-design-...
```

每个 DOI 落到一个目录，**正文和 SI 平铺在一起**：

```
2024_Yin_machine-learning-.../
  main.pdf                        正文
  41467_2023_44674_MOESM1_ESM.pdf 补充材料（保持原始格式：PDF/DOCX/XLSX/ZIP）
  41467_2023_44674_MOESM2_ESM.pdf
  41467_2023_44674_MOESM3_ESM.xlsx
  metadata.json                   Crossref/DataCite/arXiv 元数据
  report.json                     本次取件的完整诊断（来源、失败原因、耗时）
```

`report.json` 的 `si_assets` 记录了每个 SI 的来源 URL，所以平铺也不会丢失出处。

## 安装

```powershell
uv venv .venv --python 3.12
uv pip install --python .venv\Scripts\python.exe -e ".[browser,webvpn]"
```

只想用公开渠道（不装浏览器依赖）：

```powershell
uv pip install --python .venv\Scripts\python.exe -e .
```

`browser` = Playwright（登录校园网关用）；`webvpn` = pycryptodome（网关 URL 改写用）。

## 用法

```powershell
# 单篇 / 多篇
doi-fetch fetch 10.1038/nature12373
doi-fetch fetch 10.1038/xxx 10.1126/yyy --out D:\papers

# 只要正文，不要 SI
doi-fetch fetch 10.1038/xxx --no-si

# 机器可读输出
doi-fetch fetch 10.1038/xxx --json

# 强制只用公开渠道
doi-fetch fetch 10.1038/xxx --auth none
```

## 中科大 WebVPN 配置

USTC 的网关是 `wvpn.ustc.edu.cn`（网瑞达 WEngine），登录一次后所有付费墙论文自动走网关。三条路任选，**后两条不依赖 Playwright**。

**方式一：登录网关（窗口里点「登录网关」）**

```powershell
doi-fetch login --school ustc
```

弹出真实 Chrome，走统一身份认证。注意：会跳到 `id.ustc.edu.cn/cas/login?...`，**那是中科大统一身份认证的正规页面，不是钓鱼站**（页面标题「中国科学技术大学统一身份认证」，正文写着「即将前往『WEBVPN系统』」）。

**方式二：读 Chrome（要求先完全退出 Chrome）**

```powershell
doi-fetch auth from-chrome --school ustc
```

直接解密你 Chrome 里的网关 cookie，完全不碰 SSO。限制：Chrome 运行时 cookie 数据库被独占锁定（Windows 文件锁），必须先退出浏览器；Chrome 若启用了 v20 app-bound 加密则无法离线解密。

**方式三：粘贴 Cookie（最稳，永远可用）**

1. 在 Chrome 里登录 <https://wvpn.ustc.edu.cn>
2. F12 → Network → 任意请求 → 复制 `Cookie` 请求头
3. 执行：

```powershell
doi-fetch auth import-cookie --school ustc
```

**登录一直循环怎么办**

如果输入密码确认后又回到登录页，说明 CAS 把这次登录驳回了。工具会在日志里打印**驳回前那一页的原文**，据此判断是密码、账号风险控制还是二次验证问题。

工具已经去掉了自动化浏览器的识别特征（`navigator.webdriver`、`--enable-automation`、`window.chrome`、语言/插件指纹）——学校 CAS 或 WAF 常据此静默拒绝登录，表现就是密码正确却反复弹回登录页。

判断到底是不是工具的问题：用你日常的 Chrome 打开 <https://wvpn.ustc.edu.cn> 登录一次。

- 日常 Chrome 也循环 → 是账号/权限侧的问题，找学校网络中心
- 日常 Chrome 正常 → 用「粘贴 Cookie」把那次登录态的 cookie 导进来即可

之后验证：

```powershell
doi-fetch auth status          # 会话有效则显示 valid
doi-fetch fetch 10.1016/j.xxxx # 自动走网关
```

Cookie 过期（一般几天到两周）后重跑 `doi-fetch login` 即可。退出登录：`doi-fetch auth logout`。

> 配置和登录态默认存在 `~/.doifetch/`，论文默认存到 `~/doifetch-papers/`。如果这两个位置不可写（受管控的机器），会自动退到 `%LOCALAPPDATA%\doi-fetch` 再到项目下的 `_data/`、`papers/`，不会因为权限问题直接崩掉。

### 登录报 EPERM / mkdtemp 怎么办

```
BrowserType.launch_persistent_context: EPERM: operation not permitted,
mkdtemp 'C:\Users\...\AppData\Local\Temp\playwright-artifacts-XXXXXX'
```

这是 `%TEMP%` 不可写导致的。Playwright 的 Node 驱动调 `mkdtemp` 时**不像 Python 那样有回退**，所以直接失败。工具已经会自动把 `TEMP`/`TMP`/`TMPDIR` 重定向到可写目录（`<配置目录>/tmp`），并在 Chrome → Edge → 内置 Chromium 之间依次尝试。

如果仍然失败（比如被杀软或组策略拦住），点窗口里的「粘贴 Cookie」走另一条路。

### 网关 URL 是怎么改写的

网瑞达（WEngine）把普通 URL 改写为：

```
https://wvpn.ustc.edu.cn/<scheme>[-<port>]/<hex(iv)><hex(AES-CFB(key, iv, hostname))><path>?<query>
```

只有**主机名**被加密，路径保持明文；`iv` 以 hex 形式前置，所以存量网关的 URL 一律以 `77726476706e69737468656265737421` 开头（就是 `wrdvpnisthebest!` 的 ASCII 字节）。实现见 `src/doifetch/auth.py`。

学校清单（145 所）来自 scansci-pdf 的公开数据（Apache-2.0），见 `src/doifetch/data/schools.json`。查学校：

```powershell
doi-fetch schools 北京
doi-fetch schools ustc
```

## 取件策略

按代价从低到高分层，先拿到的赢：

| 层 | 来源 | 是否需要权限 |
|---|---|---|
| 1 | Unpaywall / OpenAlex / Semantic Scholar / Europe PMC / PMC OA / arXiv | 否 |
| 2 | 出版商直链（Wiley pdfdirect、Springer content/pdf、ACS、Science…） | 通常需要 |
| 3 | 落地页解析：`citation_pdf_url` meta + PDF 锚点 | 视情况 |
| 4 | 走 WebVPN 网关重试以上直链与落地页 | 需要校园登录态 |

SI 的发现顺序独立于正文（正文有 OA 版本不代表 SI 也开放）：

1. 落地页的 SI 链接（Springer `MOESM*_ESM`、Elsevier `mmc1`、ACS `suppl_file`、Wiley `downloadSupplement`、PLOS `type=supplementary`、RSC `suppdata`、PNAS `sapp`、Science `_sm`…）
2. Europe PMC 的 SI 归档 / PMC 的 `/bin/` 附件
3. Figshare 镜像（ACS、T&F、SAGE、PLOS 常把 SI 放这里，能绕过 ACS 付费墙）

## 状态码

`report.json` 里的 `pdf_status`：

| 值 | 含义 | 下一步 |
|---|---|---|
| `downloaded` | 成功 | — |
| `needs_auth` | 有付费墙或需要登录 | `doi-fetch login` |
| `blocked` | 出版商直接拒绝（403/CF 拦截） | 换网络或用网关登录态 |
| `not_found` | 各渠道都没有 PDF | 检查 DOI 是否正确 |
| `invalid_pdf` | 拿回来的不是 PDF（常见是 HTML 错误页） | — |

## 已知边界

- **不绕过任何法外渠道**：没有 Sci-Hub / LibGen / Tor。只有公开 OA 和**你自己的**校园授权。
- **SI 也可能需要授权**：出版商对补充材料链接一样会拦。工具先走公开渠道，拿到 HTML 登录页时自动改用网关会话重试；仍然拿不到就丢弃并写进 `report.json`，**不会把登录页存成 .pdf**。
- 正文和 SI 都是**原始格式**；把 SI 合并进正文 PDF、建图表交叉引用链接，是下一步的事，本项目暂不做。
- 加密 PDF 不做处理；扫描版 SI 不做 OCR。
- 出版商改版会导致选择器失效——`report.json` 的 `notes` 会写明哪一层失败，便于定位。
- **Elsevier (ScienceDirect) 目前取不到**：它的正文页是 JS 渲染的，页面里根本没有 PDF 链接（`pdf_links=0`）；就算拼出 `pdfft` 直链并带上校园网关会话，返回的也是 403 加一个 834 KB 的机器人验证页。实测换成真实 Edge（Playwright，有头/无头都试过）依然停在「请稍候…」的 JS 挑战上——这是 Elsevier 对这条访问路径的主动质询，不是 headless 检测。

  这类论文走**浏览器扩展**更靠谱：扩展在你自己已登录的浏览器里以正常用户身份下载，没有自动化痕迹。命令行批量跑完后，用结果表挑出 `failed` 的那几篇，逐个在论文页点一下扩展即可。

  同一批 34 篇里的实际分布：Nature / Science 全部拿下（含付费墙的，走网关），Elsevier 6 篇全灭。

- **Elsevier API 通道已内置，但需要机构授权（entitlement）**。命令行会自动尝试 `api.elsevier.com`（先直连、再走网关），这是唯一不受 Cloudflare 影响的程序化路径。配置：

  ```powershell
  doi-fetch config elsevier_api_key <your-key>      # dev.elsevier.com 免费申请
  doi-fetch config elsevier_insttoken <token>       # 机构令牌，向图书馆索取
  ```

  只有 key 不够。实测：key 有效（能拿到结构化 `service-error`），但全文接口一律返回
  `AUTHENTICATION_ERROR: Requestor configuration settings insufficient`——**连 Elsevier 自己标注为开放获取的文章也一样**，所以这不是"某篇没订阅"，而是授权没配上。Elsevier 要求请求来自订阅机构网段，或同时提供 `insttoken`。

  注意 WebVPN 的出口 **不算**订阅网段（实测网关内、网关外返回同一个错误）。要让 key 生效，需要真正分配校内 IP 的 SSL VPN，或者向图书馆申请 `insttoken`。

  > 附带一个反直觉的坑：Elsevier 文档建议请求带"描述性 User-Agent"，但 `api.elsevier.com` 前面套了 Cloudflare——只有写着 `doi-fetch (...)` 的 UA 会被判成机器人并返回一大坨 HTML 403，换成浏览器 UA 才能拿到正常的 XML 报错。代码按实际行为走。

## 开发

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pytest -q
```

模块分工：

```
src/doifetch/
  cli.py           命令行入口
  fetch.py         编排：分层竞速、落盘、状态判定
  net.py           HTTP 会话、内容校验、重试
  metadata.py      DOI 归一化、doi.org 跳转、Crossref
  oa.py            OA 定链（Unpaywall/OpenAlex/EuropePMC/PMC/arXiv/S2）
  publishers.py    落地页解析、SI 链接识别、Figshare/PMC 兜底
  auth.py          WebVPN URL 改写 + 登录态持久化
  schools.py       学校注册表
```

## 许可

MIT。`src/doifetch/data/schools.json` 数据来源于 scansci-pdf（Apache-2.0）。
