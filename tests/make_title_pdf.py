# PDF type "plaquette" : titre énorme, police condensée grasse, deux couleurs sur une même ligne
import asyncio, sys
from playwright.async_api import async_playwright
HTML = '''<html><head><style>
@font-face{font-family:Cond;src:url(file:///usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf);font-weight:700}
body{margin:60px;font-family:Cond;font-weight:700}
small{color:#b85c00;letter-spacing:4px;font-size:22px}
h1{font-size:96px;line-height:.95;color:#202530;margin:30px 0}
h1 span{color:#c05a00}
</style></head><body><small>GUIDE DU MONITEUR-FORMATEUR</small>
<h1>QUEL EST<br>MON <span>PALIER</span> ?</h1></body></html>'''
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--allow-file-access-from-files'])
        pg = await b.new_page()
        open('/tmp/title_src.html', 'w').write(HTML)
        await pg.goto('file:///tmp/title_src.html'); await pg.wait_for_timeout(500)
        await pg.pdf(path=sys.argv[1], format='A4')
        await b.close()
asyncio.run(main())
