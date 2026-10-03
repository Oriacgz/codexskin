import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {renderApp} from '../src/core/ui-page.js';

test('theme removal confirmation cancels safely, resets prior answers and renders names as text',async()=>{
 const html=renderApp({token:'test'});
 const functionSource=html.slice(html.indexOf('function confirmThemeRemoval('),html.indexOf('  async function importFile('));
 let close;
 const dialog={returnValue:'remove',addEventListener(event,fn,options){assert.equal(event,'close');assert.equal(options.once,true);close=fn;},showModal(){this.open=true;}};
 const name={textContent:''};
 const context=vm.createContext({$:id=>id==='removeConfirm'?dialog:name});
 vm.runInContext(functionSource,context);
 const pending=context.confirmThemeRemoval('<img src=x>');
 assert.equal(dialog.returnValue,'cancel');assert.equal(name.textContent,'<img src=x>');
 close();assert.equal(await pending,false,'Escape or Cancel must not authorize removal');
 const approved=context.confirmThemeRemoval('My theme');dialog.returnValue='remove';close();assert.equal(await approved,true);
 const again=context.confirmThemeRemoval('Another theme');close();assert.equal(await again,false,'earlier approval must not leak into next dialog');
 assert.ok(html.includes('method="dialog"'));
 assert.ok(!html.includes("confirm('Remove this theme"));
});
