import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
// Typing a note must never reach the page's own keyboard shortcuts (GitHub "t", annotation tools).
const eventually=async(check,timeout=10000)=>{const end=Date.now()+timeout;for(;;){try{return await check();}catch(error){if(Date.now()>end)throw error;}await new Promise(r=>setTimeout(r,25));}};
const root=path.resolve(import.meta.dirname,'..');
const temp=await mkdtemp(path.join(tmpdir(),'pagecrit-hotkeys-'));
const fixture=await readFile(path.join(root,'tests/hotkeys-fixture.html'));
const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(fixture);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
let context;
try {
 // Synthetic test copy only: localhost permission to inject, open shadow root so Playwright can find controls.
 const ext=path.join(temp,'extension'); await cp(path.join(root,'extension'),ext,{recursive:true});
 const manifest=JSON.parse(await readFile(path.join(ext,'manifest.json'),'utf8'));
 manifest.host_permissions=['http://127.0.0.1/*'];
 await writeFile(path.join(ext,'manifest.json'),JSON.stringify(manifest));
 const contentSource=await readFile(path.join(ext,'content.js'),'utf8');
 assert.ok(contentSource.includes("host.attachShadow({ mode: 'closed' })"));
 await writeFile(path.join(ext,'content.js'),contentSource.replace("host.attachShadow({ mode: 'closed' })","host.attachShadow({ mode: 'open' })"));
 context=await chromium.launchPersistentContext(path.join(temp,'profile'),{channel:'chromium',headless:true,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const page=await context.newPage(); await page.goto(url);
 // Positive control: the fixture's shortcuts do fire for keys pressed on the page itself.
 await page.keyboard.press('a'); await page.keyboard.press('t');
 assert.deepEqual((await page.evaluate(()=>window.fired)).filter(f=>/^(annotate|finder):/.test(f)),['annotate:a','finder:t']);
 await page.evaluate(()=>{document.activeElement.blur();window.fired=[];});
 const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,url);
 await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},files:['core.js','content.js']}),tabId);
 const ui=page.locator('[data-pagecrit-root]');
 await ui.getByRole('region',{name:'PageCrit review'}).waitFor();
 await ui.getByRole('button',{name:'Pin',exact:true}).click();
 await ui.getByRole('button',{name:'Pin to element',exact:true}).click();
 await page.locator('#target').click();
 const note=ui.locator('textarea');
 await note.waitFor();
 await page.evaluate(()=>{window.fired=[];});
 const text='tap the cart to open a pricier route';
 await page.keyboard.type(text);
 assert.deepEqual(await page.evaluate(()=>window.fired),[],'page listeners saw keystrokes typed into the note');
 assert.equal(await page.evaluate(()=>document.activeElement?.id||''),'','page hotkey moved focus out of the note');
 assert.equal(await note.inputValue(),text);
 console.log('PASS note keystrokes stay inside PageCrit; page hotkeys never fired');
 await page.keyboard.press('ControlOrMeta+Enter');
 await eventually(async()=>assert.match(await ui.getByRole('button',{name:/^Note 1:/}).getAttribute('aria-label'),/tap the cart/));
 // Escape inside the note box still cancels a draft.
 await page.locator('#target').click(); await note.waitFor(); await page.keyboard.type('discard me');
 await page.keyboard.press('Escape'); await eventually(async()=>assert.equal(await note.count(),0));
 await page.keyboard.press('Escape');
 await ui.getByRole('button',{name:/Copy Markdown/}).click();
 const markdown=await eventually(async()=>{const recent=(await worker.evaluate(async()=>(await chrome.storage.local.get('recent')).recent||[]))[0]?.markdown||'';assert.ok(recent.includes(text));return recent;});
 assert.ok(markdown.includes(text));
 console.log('PASS ⌘/Ctrl+Enter saves, Escape cancels, and the Markdown export contains the note');
} finally {
 if(context)await context.close();
 await new Promise(resolve=>server.close(resolve));
 await rm(temp,{recursive:true,force:true});
}
