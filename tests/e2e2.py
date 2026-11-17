import sys, json, asyncio
from playwright.async_api import async_playwright
HTML = 'file:///home/claude/pdf_editor/index.html'
PDF = sys.argv[1] if len(sys.argv) > 1 else '/tmp/test.pdf'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/out.pdf'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 950}, accept_downloads=True)
        logs = []
        pg.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
        await pg.goto(HTML)
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', PDF)
        await pg.wait_for_selector('#pagewrap:not([hidden])')
        await pg.wait_for_timeout(1200)
        async def scr(x, y):  # points de page -> écran
            r = await pg.evaluate('''([x,y]) => { const s=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [s.left+x*z, s.top+y*z]; }''', [x, y])
            return r
        async def click_pt(x, y, **kw):
            sx, sy = await scr(x, y); await pg.mouse.click(sx, sy, **kw)
        lines = await pg.evaluate('window.__pdfEditor.S.lines[0].map(l=>({s:l.str, r:l.rect}))')
        def ctr(l): return l['r']['x'] + 30, l['r']['y'] + l['r']['h'] / 2
        # 1. modifier la ligne Helvetica
        await pg.keyboard.press('t')
        await click_pt(*ctr(lines[1]))
        await pg.wait_for_timeout(300)
        await pg.keyboard.press('Control+a')
        await pg.keyboard.type('Texte modifié par l\'éditeur — accents OK : éàçœ €')
        await pg.screenshot(path='/tmp/s2_editing.png')
        # clic ailleurs pour valider
        await click_pt(400, 560)
        await pg.keyboard.type('Nouveau texte ajouté')
        await pg.keyboard.press('Escape')
        await pg.wait_for_timeout(1200)
        # 2. modifier le texte blanc sur bleu
        lines = await pg.evaluate('window.__pdfEditor.S.lines[0].map(l=>({s:l.str, r:l.rect}))')
        print('lignes après 1re modif:', [l['s'] for l in lines])
        blue = [l for l in lines if 'blanc' in l['s']][0]
        await click_pt(*ctr(blue))
        await pg.wait_for_timeout(200)
        await pg.keyboard.press('Control+a'); await pg.keyboard.type('Titre modifié sur fond bleu')
        await pg.keyboard.press('Escape')
        await pg.wait_for_timeout(1000)
        # 3. zone rectangulaire
        await pg.keyboard.press('r')
        sx, sy = await scr(380, 120); ex, ey = await scr(520, 200)
        await pg.mouse.move(sx, sy); await pg.mouse.down(); await pg.mouse.move(ex, ey, steps=5); await pg.mouse.up()
        await pg.wait_for_timeout(300)
        # 4. déplacer l'image
        await pg.keyboard.press('v')
        img = await pg.evaluate("window.__pdfEditor.S.objs[0].find(o=>o.type==='pdfimage')")
        cx, cy = img['x'] + img['w'] / 2, img['y'] + img['h'] / 2
        sx, sy = await scr(cx, cy); ex, ey = await scr(cx + 150, cy + 90)
        await pg.mouse.move(sx, sy); await pg.mouse.down(); await pg.mouse.move(ex, ey, steps=8); await pg.mouse.up()
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/s3_edited.png')
        # 5. export
        async with pg.expect_download() as dl:
            await pg.click('#btnSave')
        d = await dl.value
        await d.save_as(OUT)
        print('export ->', OUT)
        print('\n'.join(l for l in logs if 'error' in l.lower() or 'warn' in l.lower())[:3000])
        await b.close()
asyncio.run(main())
