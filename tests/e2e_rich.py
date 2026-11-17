# Texte riche : listes à puces / numérotées, retraits, gras, souligné, couleur, taille
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
        class Kb:
            async def press(self, k):
                await pg.keyboard.press(k); await pg.wait_for_timeout(70)
            async def type(self, s):
                await pg.keyboard.type(s); await pg.wait_for_timeout(70)
        K = Kb()
        await pg.mouse.click(*await pt(72, 560))
        await pg.wait_for_timeout(200)
        for i, t in enumerate(['Liste de courses', 'Pain complet', 'Lait', 'Oeufs bio', 'Fruits']):
            if i: await K.press('Enter')
            await K.type(t)
        await K.press('Control+Home'); await K.press('Shift+End'); await K.press('Control+b')       # titre en gras
        await pg.evaluate("(()=>{const e=document.querySelector('#fColor'); e.value='#1d4ed8'; e.dispatchEvent(new Event('input',{bubbles:true}));})()"); await pg.wait_for_timeout(120)
        await pg.fill('#fSize', '18'); await pg.press('#fSize', 'Enter'); await pg.wait_for_timeout(120)
        await K.press('ArrowDown'); await K.press('Home'); await K.press('Shift+Control+End')
        await pg.click('#fNum'); await pg.wait_for_timeout(120)                                                                       # liste numérotée sur les 4 lignes
        await K.press('Control+Home'); await K.press('ArrowDown'); await K.press('ArrowDown'); await K.press('Tab')   # "Lait" en retrait
        await K.press('ArrowDown'); await K.press('Home'); await K.press('Shift+End')
        await pg.evaluate("(()=>{const e=document.querySelector('#fColor'); e.value='#dc2626'; e.dispatchEvent(new Event('input',{bubbles:true}));})()"); await pg.wait_for_timeout(120)
        await K.press('Control+u')
        await K.press('ArrowDown'); await K.press('Home'); await K.press('Shift+End'); await pg.click('#fBul'); await pg.wait_for_timeout(120)   # dernière ligne en puce
        await pg.screenshot(path='/tmp/sr_edit.png')
        await K.press('Escape'); await pg.wait_for_timeout(600)
        o = await pg.evaluate("window.__pdfEditor.S.objs[0].find(o=>o.type==='text')")
        print(json.dumps(o['paras'], ensure_ascii=False))
        print('fFont=', await pg.evaluate("[document.querySelector('#fFont').value, document.querySelector('#fFont').selectedIndex, JSON.stringify(window.__pdfEditor.S.objs[0].find(o=>o.type==='text').font)]"))
        await pg.screenshot(path='/tmp/sr_view.png')
        async with pg.expect_download() as dl: await pg.click('#btnSave')
        await (await dl.value).save_as('/tmp/outr.pdf'); await b.close()
asyncio.run(main())
