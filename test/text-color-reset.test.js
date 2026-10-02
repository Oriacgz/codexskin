import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {renderApp} from '../src/core/ui-page.js';

test('text color reset leaves other editor settings intact and waits for Save',()=>{
 const html=renderApp({token:'test'});
 const handler=html.match(/\$\('resetTextColors'\)\.onclick=\(\)=>\{([\s\S]*?)\n  \};/)[1];
 const controls={textColorsEnabled:{checked:true},primaryTextColor:{value:'#ff0000'},secondaryTextColor:{value:'#00ff00'},brightness:{value:65},sidebarDarkness:{value:80}};
 let previews=0;
 vm.runInNewContext(handler,{$:id=>controls[id],editorDefaults:{defaults:{primaryTextColor:'#f4f6f8',secondaryTextColor:'#a1a8b0'}},updatePreview(){previews++;},toast(){}});
 assert.equal(controls.textColorsEnabled.checked,false);
 assert.equal(controls.primaryTextColor.value,'#f4f6f8');
 assert.equal(controls.secondaryTextColor.value,'#a1a8b0');
 assert.equal(controls.brightness.value,65);
 assert.equal(controls.sidebarDarkness.value,80);
 assert.equal(previews,1);
});
