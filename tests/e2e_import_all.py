# importe toutes les pages de la brochure réelle (une par une, à la demande) puis exporte
import sys, asyncio, time
from playwright.async_api import async_playwright
PDF = '/tmp/brochure.pdf'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 1000}, accept_downloads=True)
        logs = []; pg.on('console', lambda m: logs.append(m.text) if m.type == 'error' else None); pg.on('pageerror', lambda e: logs.append(str(e)))
        await pg.goto('file:///home/claude/pdf_editor/index.html')
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', PDF)
        await pg.wait_for_selector('#pagewrap:not([hidden])')
        n = await pg.evaluate('window.__pdfEditor.S.pages.length')
        for i in range(n):
            t0 = time.time()
            if i > 0:
                await pg.evaluate("document.querySelector('#toast').textContent=''")
                r = await pg.evaluate(f'window.__pdfEditor.gotoPage({i}).then(()=>null,e=>String(e.stack||e))'); print('goto', r)
            await pg.wait_for_function("document.querySelector('#toast') && /Page analysée|impossible|Aucun/.test(document.querySelector('#toast').textContent)", timeout=180000)
            await pg.wait_for_function("!window.__pdfEditor.S.importing", timeout=60000)
            print(i + 1, '%.0fs' % (time.time() - t0), await pg.evaluate("document.querySelector('#toast').textContent"), flush=True)
        await pg.wait_for_timeout(3000)
        async with pg.expect_download() as dl: await pg.click('#btnSave')
        d = await dl.value; await d.save_as('/tmp/imp_all.pdf')
        print('erreurs:', logs[:5]); await b.close()
asyncio.run(main())
