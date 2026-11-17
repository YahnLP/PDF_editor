# ouvre la brochure réelle : l'import automatique de la page doit transformer l'image en texte modifiable
import sys, asyncio, json, time
from playwright.async_api import async_playwright
PDF = sys.argv[1] if len(sys.argv) > 1 else '/tmp/brochure.pdf'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 1000}, accept_downloads=True)
        logs = []; pg.on('console', lambda m: logs.append(m.text) if m.type == 'error' else None); pg.on('pageerror', lambda e: logs.append(str(e)))
        await pg.goto('file:///home/claude/pdf_editor/index.html')
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        t0 = time.time()
        await pg.set_input_files('#fileIn', PDF)
        await pg.wait_for_selector('#pagewrap:not([hidden])')
        await pg.wait_for_function("document.querySelector('#toast') && /Page analysée|impossible|Aucun/.test(document.querySelector('#toast').textContent)", timeout=120000)
        print('import: %.1fs' % (time.time() - t0), await pg.evaluate("document.querySelector('#toast').textContent"))
        await pg.wait_for_timeout(2500)
        objs = await pg.evaluate("window.__pdfEditor.S.objs[0].filter(o=>o.type==='text').map(o=>({t:o.text.slice(0,50), w:Math.round(o.w), lh:o.lh, n:(o.paras&&o.paras[0].runs.length)||1, rms:(o.rms||[]).length}))")
        for o in objs: print(o)
        await pg.screenshot(path='/tmp/imp_ui.png')
        async with pg.expect_download() as dl: await pg.click('#btnSave')
        d = await dl.value; await d.save_as('/tmp/imp_out.pdf')
        print('erreurs:', logs[:5]); await b.close()
asyncio.run(main())
