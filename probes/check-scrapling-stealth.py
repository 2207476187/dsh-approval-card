"""验证 StealthyFetcher（隐身浏览器）真能起来并渲染 JS 页面。"""
import traceback

try:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(
        "https://quotes.toscrape.com/js/",
        headless=True,
        network_idle=True,
        timeout=90_000,
    )
    quotes = page.css(".quote .text::text").getall()
    print("StealthyFetcher ->", page.status, "| JS 渲染后拿到", len(quotes), "条")
    print("标题:", page.css("title::text").get())
except Exception:
    print("StealthyFetcher FAIL")
    traceback.print_exc()
