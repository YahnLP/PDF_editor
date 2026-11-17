import sys, json, asyncio, glob
from playwright.async_api import async_playwright
HTML = 'file:///home/claude/pdf_editor/index.html'
TTF = glob.glob('/usr/share/fonts/**/DejaVuSans.ttf', recursive=True)[0]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 950}, accept_downloads=True)
        logs = []
        pg.on('console', lambda m: logs.append(f'[{m.type}] {m.text}') if m.type == 'error' else None)
        pg.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
        await pg.goto(HTML)
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', '/tmp/test.pdf')
        await pg.wait_for_selector('#pagewrap:not([hidden])'); await pg.wait_for_timeout(1000)
        async def scr(x, y):
            return await pg.evaluate('''([x,y]) => { const s=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [s.left+x*z, s.top+y*z]; }''', [x, y])
        S = lambda expr: pg.evaluate(f'(() => {{ const S=window.__pdfEditor.S; return {expr} }})()')
        img = await S("S.objs[0].find(o=>o.type==='pdfimage')")
        # sélectionner + redimensionner par la poignée SE (proportions conservées)
        await pg.keyboard.press('v')
        await pg.mouse.click(*await scr(img['x'] + 50, img['y'] + 50))
        hx, hy = await scr(img['x'] + img['w'], img['y'] + img['h'])
        await pg.mouse.move(hx, hy); await pg.mouse.down(); await pg.mouse.move(hx - 90, hy - 60, steps=6); await pg.mouse.up()
        await pg.wait_for_timeout(1500)
        img2 = await S("S.objs[0].find(o=>o.type==='pdfimage')")
        print('image avant', [round(img[k], 1) for k in 'xywh'], 'après', [round(img2[k], 1) for k in 'xywh'])
        # supprimer puis annuler
        await pg.keyboard.press('Delete'); await pg.wait_for_timeout(1200)
        print('après suppression: supprimée =', await S("S.objs[0].find(o=>o.type==='pdfimage').deleted"))
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(1500)
        print('après annulation: supprimée =', await S("S.objs[0].find(o=>o.type==='pdfimage').deleted"))
        # police perso + caractère hors WinAnsi
        await pg.set_input_files('#fontIn', TTF); await pg.wait_for_timeout(500)
        lines = await S("S.lines[0].map(l=>({s:l.str, r:l.rect}))")
        t = [l for l in lines if 'Helvetica' in l['s']][0]
        await pg.keyboard.press('t')
        await pg.mouse.click(*await scr(t['r']['x'] + 20, t['r']['y'] + 6)); await pg.wait_for_timeout(300)
        await pg.keyboard.press('Control+a'); await pg.keyboard.type('Ħello Ω ≠ ✓ grec αβγ'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(800)
        warn = await pg.evaluate("!!document.querySelector('.warn')")
        print('avertissement police standard:', warn)
        await pg.select_option('#props select', index=3); await pg.wait_for_timeout(300)
        warn2 = await pg.evaluate("!!document.querySelector('.warn')")
        print('avertissement après police perso:', warn2)
        await pg.screenshot(path='/tmp/s4.png')
        async with pg.expect_download() as dl: await pg.click('#btnSave')
        await (await dl.value).save_as('/tmp/out4.pdf')
        print('\n'.join(logs)[:1500])
        await b.close()
asyncio.run(main())
