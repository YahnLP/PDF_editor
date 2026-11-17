import asyncio, json
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 1150}, accept_downloads=True)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        pg.on('console', lambda m: print('[console error]', m.text[:300]) if m.type == 'error' else None)
        await pg.goto('file:///home/claude/pdf_editor/index.html')
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', '/tmp/test.pdf'); await pg.wait_for_selector('#pagewrap:not([hidden])'); await pg.wait_for_timeout(1000)
        async def pt(x, y): return await pg.evaluate('''([x,y]) => { const s=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [s.left+x*z, s.top+y*z]; }''', [x, y])
        async def key(k): await pg.keyboard.press(k); await pg.wait_for_timeout(80)
        # 1. ligne existante : mettre un mot en gras + un autre en rouge
        l = await pg.evaluate('window.__pdfEditor.S.lines[0][1].rect')
        await pg.mouse.click(*await pt(l['x'] + 10, l['y'] + 6)); await pg.wait_for_timeout(300)
        await key('Home'); await key('Control+Shift+ArrowRight'); await key('Control+b')       # "Ceci " en gras
        await key('Control+ArrowRight'); await key('Control+Shift+ArrowRight')
        await pg.evaluate("(()=>{const e=document.querySelector('#fColor'); e.value='#dc2626'; e.dispatchEvent(new Event('input',{bubbles:true}));})()")
        await pg.wait_for_timeout(150)
        await key('Escape'); await pg.wait_for_timeout(1200)
        o = [o for o in json.loads(await pg.evaluate("JSON.stringify(window.__pdfEditor.S.objs[0])")) if o.get('rm')][0]
        print('runs ligne existante:', json.dumps(o['paras'][0]['runs'], ensure_ascii=False))
        # 2. liste : Entrée sur puce vide = sortie de liste
        await pg.mouse.click(*await pt(72, 600)); await pg.wait_for_timeout(200)
        await pg.click('#fBul'); await pg.keyboard.type('un'); await key('Enter'); await pg.keyboard.type('deux'); await key('Enter'); await key('Enter'); await pg.keyboard.type('fin')
        await key('Control+z')   # annulation dans l'éditeur : ne doit pas déclencher l'annulation de l'application
        await key('Control+y'); await key('Escape'); await pg.wait_for_timeout(500)
        o2 = [o for o in json.loads(await pg.evaluate("JSON.stringify(window.__pdfEditor.S.objs[0])")) if o['type'] == 'text' and not o.get('rm')][0]
        print('liste:', json.dumps(o2['paras'], ensure_ascii=False))
        # 3. annuler / rétablir au niveau application
        n = await pg.evaluate('window.__pdfEditor.S.undo.length')
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(600)
        print('undo app:', n, '->', await pg.evaluate('window.__pdfEditor.S.undo.length'), '| objets texte restants:', await pg.evaluate("window.__pdfEditor.S.objs[0].filter(o=>o.type==='text').length"))
        await pg.keyboard.press('Control+y'); await pg.wait_for_timeout(600)
        async with pg.expect_download() as dl: await pg.click('#btnSave')
        await (await dl.value).save_as('/tmp/outr2.pdf'); await b.close()
asyncio.run(main())
