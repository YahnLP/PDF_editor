# Champs de formulaire : création, export, vérification avec pypdf
import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 1150}, accept_downloads=True)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        pg.on('console', lambda m: print('[console error]', m.text) if m.type == 'error' else None)
        await pg.goto('file:///home/claude/pdf_editor/index.html')
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', '/tmp/test.pdf'); await pg.wait_for_selector('#pagewrap:not([hidden])'); await pg.wait_for_timeout(1000)
        async def pt(x, y): return await pg.evaluate('''([x,y]) => { const s=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [s.left+x*z, s.top+y*z]; }''', [x, y])
        async def drag(a, c):
            await pg.mouse.move(*await pt(*a)); await pg.mouse.down(); await pg.mouse.move(*await pt(*c), steps=4); await pg.mouse.up()
        await pg.click('[data-tool=field]')
        await drag((72, 560), (280, 584))                 # champ texte
        await pg.fill('#props input[type=text]', 'nom_client')
        await pg.keyboard.press('Tab')
        await pg.click('[data-tool=field]'); await pg.click('#props button:has-text("Case à cocher")')
        await pg.mouse.click(*await pt(300, 565))          # case par défaut
        await pg.click('[data-tool=field]'); await pg.click('#props button:has-text("Liste déroulante")')
        await drag((330, 560), (480, 584))
        await pg.click('[data-tool=field]'); await pg.click('#props button:has-text("Multiligne")')
        await drag((72, 600), (300, 660))
        await pg.wait_for_timeout(500)
        print('champs:', await pg.evaluate("window.__pdfEditor.S.objs[0].filter(o=>o.type==='field').map(o=>o.ftype+':'+o.name)"))
        await pg.screenshot(path='/tmp/sf.png')
        async with pg.expect_download() as dl: await pg.click('#btnSave')
        await (await dl.value).save_as('/tmp/outf.pdf'); await b.close()
asyncio.run(main())
