"""检查 scrapling 是否可用：解析器（离线）+ HTTP 抓取（联网）+ 隐身浏览器（本机是否装了内核）。

用法：python probes/check-scrapling.py
"""
import sys
import traceback

print("python", sys.version.split()[0], sys.executable)

try:
    import scrapling
    print("scrapling", getattr(scrapling, "__version__", "?"))
except Exception:
    traceback.print_exc()
    raise SystemExit(1)

# 1) 解析器：纯离线，验证 CSS / XPath / 正则三条路
try:
    from scrapling.parser import Selector
    html = '<html><body><div class="q"><span class="t">hello</span><a href="/x">link</a></div></body></html>'
    page = Selector(html)
    print("parser.css  ->", page.css(".q .t::text").get())
    print("parser.xpath->", page.xpath('//a/@href').get())
    print("parser.find_all->", [e.tag for e in page.find_all("div", class_="q")])
except Exception:
    print("parser FAIL")
    traceback.print_exc()

# 2) HTTP 抓取：需要 curl_cffi
try:
    from scrapling.fetchers import Fetcher
    page = Fetcher.get("https://quotes.toscrape.com/", timeout=30)
    quotes = page.css(".quote .text::text").getall()
    print("Fetcher HTTP ->", page.status, "| 拿到", len(quotes), "条", "| 第一条:", (quotes[0][:40] if quotes else "-"))
except Exception:
    print("Fetcher FAIL")
    traceback.print_exc()

# 3) 隐身浏览器：需要已下载的内核（scrapling install）
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        chromium = p.chromium.executable_path
        import os
        print("playwright chromium ->", chromium, "| 存在:", os.path.exists(chromium))
except Exception:
    print("playwright 检查失败")
    traceback.print_exc()
