import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { libraryThemeId, fetchLibraryTheme, libraryProtocolArgument, queueLibraryTheme, pendingLibraryTheme, dismissLibraryTheme } from "../src/core/library-import.js";
const id="12345678-1234-4234-8234-123456789012";
test("community protocol accepts only a theme ID and fixed library source",async()=>{
 assert.equal(libraryThemeId(`codexskin://import?theme=${id}`),id);
 for(const value of [`codexskin://other?theme=${id}`,`codexskin://import?theme=${id}&url=http://localhost`,`codexskin://import/path?theme=${id}`,`https://import?theme=${id}`,`codexskin://import?theme=${id}&theme=${id}`])assert.throws(()=>libraryThemeId(value));
 const bytes=await fetchLibraryTheme(id,async(url,options)=>{assert.ok(url.startsWith("https://codextheme-web-frontend.vercel.app/api/community?route=themes%2F"));assert.equal(options.redirect,"error");return new Response(Buffer.from("package"));});
 assert.equal(bytes.toString(),"package");
 await assert.rejects(fetchLibraryTheme(id,async()=>new Response("",{status:404})),/download failed/);
});

test("protocol invocation rejects injected launcher options",()=>{
 assert.equal(libraryProtocolArgument([`CODEXSKIN://import?theme=${id}`]),`CODEXSKIN://import?theme=${id}`);
 assert.throws(()=>libraryProtocolArgument([`codexskin://import?theme=${id}`,"--browser","unknown.exe"]));
 assert.throws(()=>libraryProtocolArgument([`CODEXSKIN://import?theme=${id}`,"--port","80"]));
 assert.equal(libraryProtocolArgument(["--no-open"]),null);
});

test("canceling an older import cannot dismiss its replacement", async()=>{
 const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"cs-library-"));
 const previous = process.env.CODEXSKIN_HOME;
 process.env.CODEXSKIN_HOME = temporary;
 try {
  const second="abcdefab-1234-4234-8234-123456789012";
  await queueLibraryTheme(`codexskin://import?theme=${id}`);
  await queueLibraryTheme(`codexskin://import?theme=${second}`);
  await dismissLibraryTheme(id);
  assert.equal(await pendingLibraryTheme(),second);
  await dismissLibraryTheme(second);
  assert.equal(await pendingLibraryTheme(),null);
 } finally {
  if(previous===undefined)delete process.env.CODEXSKIN_HOME;else process.env.CODEXSKIN_HOME=previous;
  assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("cs-library-"));
  await fs.rm(temporary,{recursive:true,force:true});
 }
});
test("community download stops above the package byte limit",async()=>{
 await assert.rejects(fetchLibraryTheme(id,async()=>new Response(Buffer.alloc(33*1024*1024))),/exceeds 32 MiB/);
});
