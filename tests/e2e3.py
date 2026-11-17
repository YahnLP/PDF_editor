# usage: e2e3.py in.pdf out.pdf "sous-chaîne de ligne à modifier" "nouveau texte" [--rot]
import sys, json, asyncio
from playwright.async_api import async_playwright
HTML = 'file:///home/claude/pdf_editor/index.html'
PDF, OUT, SUB, NEW = sys.argv[1:5]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 950}, accept_downloads=True)
        logs = []
        pg.on('console', lambda m: logs.append(f'[{m.type}] {m.text}') if m.type in ('error',) else None)
        pg.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
        await pg.goto(HTML)
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', PDF)
        await pg.wait_for_selector('#pagewrap:not([hidden])')
        await pg.wait_for_timeout(1200)
        await pg.evaluate('window.__pdfEditor.S.zoom && 0')
        async def scr(x, y):
            return await pg.evaluate('''([x,y]) => { const s=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [s.left+x*z, s.top+y*z]; }''', [x, y])
        lines = await pg.evaluate('window.__pdfEditor.S.lines[0].map(l=>({s:l.str, r:l.rect, f:l.fontName}))')
        print('lignes:', [(l['s'][:40]) for l in lines])
        fonts = await pg.evaluate('''() => { const S=window.__pdfEditor.S; return S.lines[0].map(l=>{const f=S.pageProxy.commonObjs.has(l.fontName)?S.pageProxy.commonObjs.get(l.fontName):null; return f&&f.name}) }''')
        print('polices pdf.js:', fonts)
        tgts = [l for l in lines if SUB in l['s']]
        if tgts:
            tgt = tgts[0]
            await pg.keyboard.press('t')
            sx, sy = await scr(tgt['r']['x'] + 20, tgt['r']['y'] + tgt['r']['h'] / 2)
            await pg.mouse.click(sx, sy)
            await pg.wait_for_timeout(300)
            o = await pg.evaluate('window.__pdfEditor.S.objs[0].find(o=>o.rm)')
            print('objet remplacé:', json.dumps({k: o[k] for k in ('font', 'size', 'color', 'text')}, ensure_ascii=False), 'bg', o['rm']['bg'])
            await pg.keyboard.press('Control+a'); await pg.keyboard.type(NEW)
            await pg.keyboard.press('Escape')
            await pg.wait_for_timeout(1200)
            o = await pg.evaluate('window.__pdfEditor.S.objs[0].find(o=>o.rm)')
            print('maskNeeded (suppression réelle impossible si true):', o['maskNeeded'])
        else: print('aucune ligne éditable (page pivotée ?)')
        # ajout d'une zone + d'une image + d'un texte
        await pg.keyboard.press('r')
        a = await scr(380, 40); c = await scr(480, 90)
        await pg.mouse.move(*a); await pg.mouse.down(); await pg.mouse.move(*c, steps=4); await pg.mouse.up()
        await pg.set_input_files('#imgIn', '/tmp/test_img.png')
        await pg.keyboard.press('i') if False else None
        await pg.wait_for_timeout(300)
        await pg.keyboard.press('t')
        a = await scr(60, 560); await pg.mouse.click(*a); await pg.keyboard.type('Texte ajouté — fin'); await pg.keyboard.press('Escape')
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=OUT + '.png')
        async with pg.expect_download() as dl:
            await pg.click('#btnSave')
        d = await dl.value; await d.save_as(OUT)
        print('\n'.join(logs)[:2000])
        await b.close()
asyncio.run(main())
