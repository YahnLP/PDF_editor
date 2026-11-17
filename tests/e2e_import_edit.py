# après import : on retouche un paragraphe (reflux dans le bloc), on annule/rétablit, on exporte
import asyncio, time
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 1000}, accept_downloads=True)
        logs = []; pg.on('pageerror', lambda e: logs.append(str(e)))
        await pg.goto('file:///home/claude/pdf_editor/index.html')
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', '/tmp/brochure.pdf')
        await pg.wait_for_selector('#pagewrap:not([hidden])')
        await pg.wait_for_function("document.querySelector('#toast') && /Page analysée/.test(document.querySelector('#toast').textContent)", timeout=120000)
        await pg.wait_for_timeout(3000)
        o = await pg.evaluate("(()=>{const o=window.__pdfEditor.S.objs[0].find(o=>o.text&&o.text.startsWith('La classification')); return {id:o.id,x:o.x,y:o.y,w:o.w,h:o.h}})()")
        s = await pg.evaluate('''([x,y]) => { const r=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [r.left+x*z, r.top+y*z]; }''', [o['x']+60, o['y']+10])
        await pg.mouse.click(*s); await pg.wait_for_timeout(600)
        await pg.keyboard.press('Control+a')
        await pg.keyboard.type('La classification des compétences MFR traduite en tâches concrètes, observables et vérifiables, au service de chaque moniteur-formateur.', delay=8)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(1500)
        o2 = await pg.evaluate("(()=>{const o=window.__pdfEditor.S.objs[0].find(o=>o.id==='%s'); return {w:o.w,h:o.h,t:o.text.length}})()" % o['id'])
        print('avant', o, 'après', o2)
        await pg.screenshot(path='/tmp/imp_edit.png')
        async with pg.expect_download() as dl: await pg.click('#btnSave')
        d = await dl.value; await d.save_as('/tmp/imp_edit.pdf'); print(logs); await b.close()
asyncio.run(main())
