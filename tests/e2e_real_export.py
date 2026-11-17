# édite 3 lignes du PDF réel (titre, kicker, corps), modifie le texte, exporte
import sys, asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 1000}, accept_downloads=True)
        logs=[]; pg.on('console', lambda m: logs.append(m.text) if m.type=='error' else None); pg.on('pageerror', lambda e: logs.append(str(e)))
        await pg.goto('file:///home/claude/pdf_editor/index.html')
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', '/tmp/brochure.pdf')
        await pg.wait_for_selector('#pagewrap:not([hidden])'); await pg.wait_for_timeout(1500)
        async def edit(sub, new):
            lines = await pg.evaluate('window.__pdfEditor.S.lines[0].map(l=>({s:l.str,r:l.rect}))')
            t=[l for l in lines if sub in l['s']][0]
            s = await pg.evaluate('''([x,y]) => { const r=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [r.left+x*z, r.top+y*z]; }''', [t['r']['x']+t['r']['w']*0.3, t['r']['y']+t['r']['h']*0.55])
            await pg.mouse.click(*s); await pg.wait_for_timeout(2200)
            if new:
                await pg.keyboard.press('Control+a'); await pg.keyboard.type(new, delay=20); await pg.wait_for_timeout(200)
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(1200)
        await edit('QUEL EST', 'QUEL EST')          # sans changement de texte : doit rester identique
        await edit('GUIDE DU', 'GUIDE DU FORMATEUR')
        await edit('La classification', 'La classification des compétences, traduite en tâches claires.')
        await pg.screenshot(path='/tmp/real_ui.png')
        async with pg.expect_download() as dl: await pg.click('#btnSave')
        d = await dl.value; await d.save_as('/tmp/brochure_out.pdf')
        print(logs[:5]); await b.close()
asyncio.run(main())
