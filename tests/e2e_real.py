# usage: e2e_real.py in.pdf page "sous-chaîne" out.png  — clic sur une ligne d'un PDF réel (scan + OCR), capture pendant l'édition
import sys, asyncio, json
from playwright.async_api import async_playwright
PDF, PAGE, SUB, OUT = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 1000})
        logs = []; pg.on('console', lambda m: logs.append(m.text) if m.type in ('error', 'warning') and 'fake worker' not in m.text and 'readback' not in m.text else None); pg.on('pageerror', lambda e: logs.append(str(e)))
        await pg.goto('file:///home/claude/pdf_editor/index.html')
        await pg.wait_for_function('window.__pdfEditor && window.__pdfEditor.ready')
        await pg.set_input_files('#fileIn', PDF)
        await pg.wait_for_selector('#pagewrap:not([hidden])'); await pg.wait_for_timeout(1500)
        if PAGE > 0:
            await pg.evaluate(f'window.__pdfEditor.gotoPage({PAGE})'); await pg.wait_for_timeout(1500)
        lines = await pg.evaluate('window.__pdfEditor.S.lines[window.__pdfEditor.S.cur].map(l=>({s:l.str,r:l.rect,sz:l.size}))')
        t = [l for l in lines if SUB in l['s']][0]
        await pg.evaluate("document.querySelector('#stage').scrollIntoView()")
        s = await pg.evaluate('''([x,y]) => { const r=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return [r.left+x*z, r.top+y*z, z]; }''', [t['r']['x']+t['r']['w']*0.3, t['r']['y']+t['r']['h']*0.55])
        await pg.mouse.click(s[0], s[1]); await pg.wait_for_timeout(2500)
        o = await pg.evaluate('window.__pdfEditor.S.objs[window.__pdfEditor.S.cur].filter(o=>o.rm).pop()')
        print(await pg.evaluate('JSON.stringify(window.__pdfEditor.S.lastFit && window.__pdfEditor.S.lastFit.ranked)'))
        S = await pg.evaluate('window.__pdfEditor.S.fonts.map(f=>f.name)')
        print(json.dumps({k: o.get(k) for k in ('font','size','ls','color','paras','text','maskNeeded')}, ensure_ascii=False)[:600]); print('polices:', S[-3:])
        # zone autour de la ligne
        r = await pg.evaluate('''([x,y,w,h]) => { const r=document.querySelector('#stage').getBoundingClientRect(); const z=window.__pdfEditor.S.zoom; return {x:r.left+x*z,y:r.top+y*z,w:w*z,h:h*z}; }''', [max(0,t['r']['x']-10), t['r']['y']-30, t['r']['w']+80, t['r']['h']+60])
        await pg.screenshot(path=OUT, clip={'x':max(0,r['x']),'y':max(0,r['y']),'width':min(1400,r['w']),'height':min(500,r['h'])})
        print(logs[:5]); await b.close()
asyncio.run(main())
