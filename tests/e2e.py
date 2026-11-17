import sys, json, asyncio
from playwright.async_api import async_playwright
HTML = 'file:///home/claude/pdf_editor/dist/pdf-editor.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 950}, accept_downloads=True)
        logs = []
        pg.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
        await pg.goto(HTML)
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', '/tmp/test.pdf')
        await pg.wait_for_selector('#pagewrap:not([hidden])')
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/s1_loaded.png')
        info = await pg.evaluate('''() => { const S=window.__pdfEditor.S; return {pages:S.pages.length, objs:S.objs[0].map(o=>[o.type,o.kind,Math.round(o.x),Math.round(o.y),Math.round(o.w),Math.round(o.h)]), lines:S.lines[0].map(l=>[l.str,l.fontName,l.size,l.rawName||'']), zoom:S.zoom,
          fontinfo: S.lines[0].map(l=>{const f=S.pageProxy.commonObjs.has(l.fontName)?S.pageProxy.commonObjs.get(l.fontName):null; return f?Object.keys(f).slice(0,40).join(','):null}).slice(0,1),
          fname: S.lines[0].map(l=>{const f=S.pageProxy.commonObjs.has(l.fontName)?S.pageProxy.commonObjs.get(l.fontName):null; return f&&[f.name,f.bold,f.italic,f.isMonospace,f.isSerifFont,f.systemFontInfo&&f.systemFontInfo.css]})} }''')
        print(json.dumps(info, ensure_ascii=False, indent=1))
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())
