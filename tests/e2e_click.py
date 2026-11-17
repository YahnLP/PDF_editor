# clic sur une ligne : capture pendant l'édition
import sys, asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 950})
        logs=[]; pg.on('console', lambda m: logs.append(m.text) if m.type=='error' else None); pg.on('pageerror', lambda e: logs.append(str(e)))
        await pg.goto('file:///home/claude/pdf_editor/index.html')
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', sys.argv[1])
        await pg.wait_for_selector('#pagewrap:not([hidden])'); await pg.wait_for_timeout(1200)
        lines = await pg.evaluate('window.__pdfEditor.S.lines[0].map(l=>({s:l.str,r:l.rect,sz:l.size}))')
        print([(l['s'],round(l['sz'])) for l in lines])
        t=[l for l in lines if sys.argv[2] in l['s']][0]
        s = await pg.evaluate('''([x,y]) => { const r=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [r.left+x*z, r.top+y*z]; }''', [t['r']['x']+30, t['r']['y']+t['r']['h']/2])
        await pg.mouse.click(*s); await pg.wait_for_timeout(1500)
        o = await pg.evaluate('window.__pdfEditor.S.objs[0].find(o=>o.rm)')
        print({k:o[k] for k in ('font','size','color','maskNeeded')})
        await pg.screenshot(path=sys.argv[3])
        print(logs)
        await b.close()
asyncio.run(main())
